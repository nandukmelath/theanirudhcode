// Audit logging to agent_runs / agent_decisions / digest_items
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function startRun({ agentName, trigger, parentRunId, model, input }) {
  return prisma.agentRun.create({
    data: {
      agentName,
      trigger,
      parentRunId: parentRunId ? BigInt(parentRunId) : null,
      model,
      input: input || undefined,
      status: 'running',
    },
  });
}

async function finishRun(runId, { status, output, error, tokensIn, tokensOut, costUsd }) {
  return prisma.agentRun.update({
    where: { id: BigInt(runId) },
    data: {
      status,
      output: output || undefined,
      error: error || null,
      tokensIn: tokensIn ?? null,
      tokensOut: tokensOut ?? null,
      costUsd: costUsd != null ? costUsd.toFixed(6) : null,
      finishedAt: new Date(),
    },
  });
}

async function logDecision(runId, { actionType, targetTable, targetId, payload, requiresApproval, executed }) {
  return prisma.agentDecision.create({
    data: {
      runId: BigInt(runId),
      actionType,
      targetTable: targetTable || null,
      targetId: targetId ? String(targetId) : null,
      payload: payload || undefined,
      requiresApproval: !!requiresApproval,
      executed: !!executed,
      executedAt: executed ? new Date() : null,
    },
  });
}

async function addDigestItem({ category, severity, title, detail, agentRunId, digestDate }) {
  const date = digestDate || new Date();
  date.setHours(0, 0, 0, 0);
  return prisma.digestItem.create({
    data: {
      digestDate: date,
      category,
      severity: severity || 'info',
      title,
      detail: detail || null,
      agentRunId: agentRunId ? BigInt(agentRunId) : null,
    },
  });
}

async function disconnect() {
  await prisma.$disconnect();
}

module.exports = { prisma, startRun, finishRun, logDecision, addDigestItem, disconnect };
