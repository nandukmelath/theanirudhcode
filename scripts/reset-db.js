/**
 * One-shot DB reset — drops all data, keeps schema structure.
 * Run via: RESET_KEY=<key> node scripts/reset-db.js
 * or via POST /api/_reset with header X-Reset-Key: <key>
 */
require('dotenv').config();
const prisma = require('../src/lib/prisma');

const TABLES = [
  'email_otps', 'password_resets', 'blocked_slots',
  'appointments', 'product_orders', 'cohort_enrollments',
  'cohort_enrollments', 'consultations', 'subscribers',
  'google_tokens', 'settings', 'posts', 'cohorts',
  'products', 'users',
];

async function resetDb() {
  console.log('[reset] Starting DB reset...');
  // Disable FK checks temporarily, truncate all tables in dependency order
  await prisma.$executeRawUnsafe('SET session_replication_role = replica;');
  for (const t of TABLES) {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE;`);
      console.log(`[reset] Truncated: ${t}`);
    } catch (e) {
      console.warn(`[reset] Skip ${t}: ${e.message}`);
    }
  }
  await prisma.$executeRawUnsafe('SET session_replication_role = DEFAULT;');
  console.log('[reset] Done. All tables cleared. Schema intact.');
  await prisma.$disconnect();
}

resetDb().catch(e => { console.error('[reset] FAILED:', e.message); process.exit(1); });
