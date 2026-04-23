/**
 * Manual migration: adds new columns and tables for tiered consultations,
 * products, and cohorts. Uses DATABASE_URL (pooler) instead of DIRECT_URL.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Running migration for new features...');

  // 1. Add consultation_type and consultation_price to appointments
  await prisma.$executeRawUnsafe(`
    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS consultation_type  TEXT NOT NULL DEFAULT 'deepdive',
      ADD COLUMN IF NOT EXISTS consultation_price INTEGER NOT NULL DEFAULT 5000;
  `);
  console.log('  ✓ appointments: added consultation_type, consultation_price');

  // 2. Create products table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT NOT NULL,
      price       INTEGER NOT NULL,
      category    TEXT NOT NULL,
      badge       TEXT,
      features    TEXT,
      available   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('  ✓ products table created');

  // 3. Create product_orders table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS product_orders (
      id         SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      phone      TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('  ✓ product_orders table created');

  // 4. Create cohorts table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS cohorts (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      tagline          TEXT NOT NULL,
      description      TEXT NOT NULL,
      start_date       TEXT NOT NULL,
      duration_weeks   INTEGER NOT NULL,
      price            INTEGER NOT NULL,
      max_participants INTEGER NOT NULL,
      spots_left       INTEGER NOT NULL,
      is_active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('  ✓ cohorts table created');

  // 5. Create cohort_enrollments table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS cohort_enrollments (
      id         SERIAL PRIMARY KEY,
      cohort_id  INTEGER NOT NULL REFERENCES cohorts(id),
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      phone      TEXT,
      message    TEXT,
      status     TEXT NOT NULL DEFAULT 'waitlist',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('  ✓ cohort_enrollments table created');

  console.log('Migration complete!');
}

main()
  .catch(e => { console.error('Migration error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
