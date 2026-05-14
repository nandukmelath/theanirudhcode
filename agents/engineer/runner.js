// Engineer Agent entry point. Invoked by GitHub Actions cron or workflow_dispatch.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { AgentLoop } = require('../lib/anthropic');
const { startRun, finishRun, addDigestItem, disconnect } = require('../lib/db');
const { assertUnderCap } = require('../lib/cost');
const { makeTools } = require('./tools');

const MODEL = 'claude-opus-4-7';
const COST_CAP = parseFloat(process.env.AGENT_COST_CAP_USD || '5');
const REPO = process.env.REPO || 'nandukmelath/theanirudhcode';
const DRY_RUN = String(process.env.DRY_RUN || 'false') === 'true';
const TASK_HINT = process.env.TASK_HINT || '';

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const { spent, remaining } = await assertUnderCap(COST_CAP);
  console.log(`[engineer-agent] cost cap: spent $${spent.toFixed(4)} / cap $${COST_CAP} (remaining $${remaining.toFixed(4)})`);

  const run = await startRun({
    agentName: 'engineer',
    trigger: TASK_HINT ? `manual:${TASK_HINT.slice(0, 80)}` : 'cron',
    model: MODEL,
    input: { repo: REPO, dryRun: DRY_RUN, taskHint: TASK_HINT },
  });
  const runId = run.id.toString();
  console.log(`[engineer-agent] run_id=${runId} dry_run=${DRY_RUN}`);

  // Create a fresh branch up front so all edits go somewhere safe.
  const branchName = `agent/run-${runId}`;
  if (!DRY_RUN) {
    try { execSync(`git checkout -b ${branchName}`, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { console.warn('branch create failed (may already exist):', e.message); }
  }

  const system = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8');
  const { defs: tools, impls: toolImpls } = makeTools({ runId, repo: REPO, dryRun: DRY_RUN });

  const loop = new AgentLoop({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: MODEL,
    system,
    tools,
    toolImpls,
    maxTurns: 40,
    costCapUsd: Math.min(COST_CAP - spent, 3.0),
  });

  const userMessage = [
    `It is ${new Date().toISOString()}.`,
    `You are running on GitHub Actions in repo ${REPO}, branch ${branchName}.`,
    `Dry-run: ${DRY_RUN}.`,
    TASK_HINT ? `Task hint from doctor: ${TASK_HINT}` : 'No task hint — pick from backlog.',
    '',
    'Begin: call query_backlog, pick ONE high-value task, implement it carefully, open a PR, escalate or auto-merge per the safelist, log the decision + digest item, then end your turn.',
  ].join('\n');

  let result;
  let status = 'succeeded';
  let errMsg = null;
  try {
    result = await loop.run(userMessage);
    console.log(`[engineer-agent] stop=${result.stopReason} turns=${result.turn} cost=$${result.cost.toFixed(4)}`);
    if (result.stopReason === 'cost_cap' || result.stopReason === 'max_turns') status = 'partial';
  } catch (err) {
    status = 'failed';
    errMsg = err.message;
    console.error('[engineer-agent] error:', err);
  }

  await finishRun(runId, {
    status,
    output: result ? { stopReason: result.stopReason, turns: result.turn } : null,
    error: errMsg,
    tokensIn: loop.totalTokensIn,
    tokensOut: loop.totalTokensOut,
    costUsd: loop.totalCostUsd,
  });

  // Safety net: always leave a digest breadcrumb so the doctor sees the run happened.
  await addDigestItem({
    category: 'engineering',
    severity: status === 'succeeded' ? 'info' : 'warn',
    title: `Engineer agent run ${runId} → ${status}`,
    detail: `cost=$${loop.totalCostUsd.toFixed(4)} tokens_in=${loop.totalTokensIn} tokens_out=${loop.totalTokensOut} stop=${result?.stopReason || 'error'}${errMsg ? ` err=${errMsg.slice(0, 200)}` : ''}`,
    agentRunId: runId,
  });

  await disconnect();
  if (status === 'failed') process.exit(1);
}

main().catch(async (err) => {
  console.error('[engineer-agent] fatal:', err);
  try { await disconnect(); } catch {}
  process.exit(1);
});
