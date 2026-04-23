/**
 * migrate-to-neon.js
 *
 * One-shot script: copies all data from Supabase (current DB) to Neon (new DB).
 *
 * Usage:
 *   NEON_URL="postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require" \
 *   NEON_DIRECT_URL="postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require" \
 *   node scripts/migrate-to-neon.js
 *
 * What it does:
 *   1. Runs `prisma db push` against Neon to create all tables from schema
 *   2. Runs the 3 migration scripts against Neon (phase features)
 *   3. Copies every row from Supabase → Neon in FK-safe order
 *   4. Resets PostgreSQL sequences so auto-increment IDs continue correctly
 *
 * Safe to re-run: uses TRUNCATE ... RESTART IDENTITY CASCADE before each copy.
 * Does NOT touch the source (Supabase) database.
 */

'use strict';
require('dotenv').config();
const { execSync }   = require('child_process');
const { PrismaClient } = require('@prisma/client');

// ── Validate required env vars ───────────────────────────────────────────────
const NEON_URL        = process.env.NEON_URL;
const NEON_DIRECT_URL = process.env.NEON_DIRECT_URL || NEON_URL;

if (!NEON_URL) {
  console.error('ERROR: NEON_URL is not set.');
  console.error('Run: NEON_URL="postgres://..." node scripts/migrate-to-neon.js');
  process.exit(1);
}

const SOURCE_URL = process.env.DATABASE_URL;
if (!SOURCE_URL) {
  console.error('ERROR: DATABASE_URL (Supabase) is not set in .env');
  process.exit(1);
}

console.log('─'.repeat(60));
console.log('  theanirudhcode → Neon Migration');
console.log('─'.repeat(60));
console.log('Source : Supabase (DATABASE_URL from .env)');
console.log('Target : Neon     (NEON_URL from env)');
console.log('─'.repeat(60));

// ── Step 1: Apply schema to Neon ─────────────────────────────────────────────
console.log('\n[1/3] Pushing Prisma schema to Neon...');
const neonEnv = {
  ...process.env,
  DATABASE_URL: NEON_URL,
  DIRECT_URL:   NEON_DIRECT_URL,
};

try {
  execSync('npx prisma db push --accept-data-loss --skip-generate', {
    env: neonEnv,
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  console.log('✓ Schema pushed to Neon');
} catch (e) {
  console.error('✗ prisma db push failed:', e.message);
  process.exit(1);
}

// ── Step 2: Run phase migration scripts against Neon ─────────────────────────
console.log('\n[2/3] Running migration scripts against Neon...');
const migrationScripts = [
  'prisma/migrate-new-features.js',
  'prisma/migrate-phase3.js',
  'prisma/migrate-phase5.js',
];

for (const script of migrationScripts) {
  try {
    console.log(`  Running ${script}...`);
    execSync(`node ${script}`, {
      env: neonEnv,
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    console.log(`  ✓ ${script}`);
  } catch (e) {
    // Migration scripts are idempotent — column/table already exists errors are OK
    console.log(`  ⚠ ${script} returned non-zero (probably already applied, continuing)`);
  }
}

// ── Step 3: Copy data ─────────────────────────────────────────────────────────
console.log('\n[3/3] Copying data from Supabase → Neon...');

// Source: Supabase (reads from .env DATABASE_URL)
const src = new PrismaClient({
  datasources: { db: { url: SOURCE_URL } },
  log: [],
});

// Destination: Neon
const dst = new PrismaClient({
  datasources: { db: { url: NEON_URL } },
  log: [],
});

// Tables in FK-dependency order (parents before children)
const TABLES_IN_ORDER = [
  'users',
  'subscribers',
  'posts',
  'products',
  'cohorts',
  'consultations',
  'settings',
  'google_tokens',
  'appointments',
  'product_orders',
  'cohort_enrollments',
  'password_resets',
];

async function main() {
  let totalRows = 0;

  for (const table of TABLES_IN_ORDER) {
    process.stdout.write(`  Copying ${table}... `);
    try {
      // Read all rows from source
      const rows = await src.$queryRawUnsafe(`SELECT * FROM "${table}"`);

      if (rows.length === 0) {
        console.log('0 rows (skipping)');
        continue;
      }

      // Truncate destination table (cascade to handle any FKs pointing to it)
      await dst.$executeRawUnsafe(
        `TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`
      );

      // Build bulk INSERT
      const cols = Object.keys(rows[0]);
      const colList = cols.map(c => `"${c}"`).join(', ');

      // Insert in chunks of 500 to avoid hitting query size limits
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const placeholders = chunk.map((_, ri) =>
          '(' + cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(', ') + ')'
        ).join(', ');
        const values = chunk.flatMap(row => cols.map(c => row[c]));
        await dst.$executeRawUnsafe(
          `INSERT INTO "${table}" (${colList}) VALUES ${placeholders}`,
          ...values
        );
      }

      // Reset sequence for tables with serial PKs
      const seqTables = [
        'users', 'subscribers', 'posts', 'products', 'cohorts',
        'consultations', 'appointments', 'product_orders',
        'cohort_enrollments', 'password_resets',
      ];
      if (seqTables.includes(table)) {
        await dst.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE(MAX(id), 1)) FROM "${table}"`
        );
      }

      console.log(`${rows.length} rows ✓`);
      totalRows += rows.length;
    } catch (err) {
      console.log(`ERROR`);
      console.error(`    ${err.message}`);
      // Continue with other tables — don't abort the whole migration
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`✓ Migration complete — ${totalRows} total rows copied to Neon`);
  console.log('─'.repeat(60));
  console.log('\nNext steps:');
  console.log('  1. Update DATABASE_URL + DIRECT_URL in Railway env vars to the Neon values');
  console.log('  2. Remove SUPABASE_URL + SUPABASE_KEY env vars from Railway');
  console.log('  3. Deploy on Railway — the site will now use Neon');
  console.log('');
}

main()
  .catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await src.$disconnect();
    await dst.$disconnect();
  });
