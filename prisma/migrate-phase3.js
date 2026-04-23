/**
 * Phase 3 migration: DB-level race condition prevention
 * Adds a partial unique index so two concurrent bookings can never grab the same slot.
 * Uses DATABASE_URL (pooler) — safe for Supabase free tier.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Running Phase 3 migration...');

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_confirmed_slot
    ON appointments(date, time_start)
    WHERE status = 'confirmed';
  `);
  console.log('  ✓ appointments: partial unique index on confirmed (date, time_start)');

  console.log('Phase 3 migration complete!');
}

main()
  .catch(e => { console.error('Migration error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
