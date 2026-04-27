// Migration: add account lockout columns to users table
// Run: node prisma/migrate-account-lockout.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Running account lockout migration...');
  await prisma.$executeRawUnsafe(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
  `);
  console.log('Migration complete. Columns added: failed_login_attempts, locked_until');
}

main()
  .catch(e => { console.error('Migration failed:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
