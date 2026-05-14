// Daily cost guard — sum agent_runs.cost_usd today vs cap
const { prisma } = require('./db');

async function todaysSpendUsd() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(SUM(cost_usd), 0)::float AS total
    FROM agent_runs
    WHERE started_at >= ${start}
  `;
  return rows?.[0]?.total ?? 0;
}

async function assertUnderCap(capUsd) {
  const spent = await todaysSpendUsd();
  if (spent >= capUsd) {
    const err = new Error(`Daily cost cap reached: $${spent.toFixed(2)} / $${capUsd}`);
    err.code = 'COST_CAP';
    throw err;
  }
  return { spent, capUsd, remaining: capUsd - spent };
}

module.exports = { todaysSpendUsd, assertUnderCap };
