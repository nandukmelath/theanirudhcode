const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pw_resets_user ON password_resets(user_id)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_pw_resets_hash ON password_resets(token_hash)`);

  await prisma.$executeRawUnsafe(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS admin_reply TEXT`);
  await prisma.$executeRawUnsafe(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`);

  console.log('[migrate-phase5] Done');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
