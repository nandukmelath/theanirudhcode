// Migration: agent ops tables (agent_runs, agent_decisions, approval_queue, digest_items)
// Run: node prisma/migrate-agents.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Running agent ops migration...');

  // agent_runs — every orchestrator/specialist agent execution
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id              BIGSERIAL PRIMARY KEY,
      agent_name      TEXT NOT NULL,
      parent_run_id   BIGINT REFERENCES agent_runs(id) ON DELETE SET NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      trigger         TEXT,
      input           JSONB,
      output          JSONB,
      error           TEXT,
      model           TEXT,
      tokens_in       INTEGER,
      tokens_out      INTEGER,
      cost_usd        NUMERIC(10,6),
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at     TIMESTAMPTZ
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_name ON agent_runs(agent_name);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at);`);

  // agent_decisions — concrete actions an agent took (or proposed)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS agent_decisions (
      id              BIGSERIAL PRIMARY KEY,
      run_id          BIGINT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
      action_type     TEXT NOT NULL,
      target_table    TEXT,
      target_id       TEXT,
      payload         JSONB,
      requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
      executed        BOOLEAN NOT NULL DEFAULT FALSE,
      executed_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_agent_decisions_run_id ON agent_decisions(run_id);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_agent_decisions_executed ON agent_decisions(executed);`);

  // approval_queue — pending human approvals (refunds, clinical replies, etc.)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS approval_queue (
      id                BIGSERIAL PRIMARY KEY,
      decision_id       BIGINT REFERENCES agent_decisions(id) ON DELETE CASCADE,
      agent_run_id      BIGINT REFERENCES agent_runs(id) ON DELETE SET NULL,
      action_type       TEXT NOT NULL,
      summary           TEXT NOT NULL,
      draft_content     TEXT,
      channel           TEXT NOT NULL DEFAULT 'whatsapp',
      status            TEXT NOT NULL DEFAULT 'pending',
      requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ,
      decided_at        TIMESTAMPTZ,
      decided_by        TEXT,
      decision_note     TEXT,
      callback_payload  JSONB
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_approval_queue_expires_at ON approval_queue(expires_at);`);

  // digest_items — items aggregated into the daily 8 AM IST digest
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS digest_items (
      id              BIGSERIAL PRIMARY KEY,
      digest_date     DATE NOT NULL,
      category        TEXT NOT NULL,
      severity        TEXT NOT NULL DEFAULT 'info',
      title           TEXT NOT NULL,
      detail          TEXT,
      agent_run_id    BIGINT REFERENCES agent_runs(id) ON DELETE SET NULL,
      delivered       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_digest_items_date ON digest_items(digest_date);`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_digest_items_category ON digest_items(category);`);

  console.log('Migration complete. Tables created: agent_runs, agent_decisions, approval_queue, digest_items');
}

main()
  .catch(e => { console.error('Migration failed:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
