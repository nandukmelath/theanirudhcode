// Tool definitions + implementations for the engineer agent.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { classifyPaths } = require('./safelist');
const { getBacklog } = require('../lib/backlog');
const { logDecision, addDigestItem } = require('../lib/db');
const { pingDoctor } = require('../lib/whatsapp');

const REPO_ROOT = process.cwd();
const ALLOWED_CMD_PREFIXES = [
  'npm ', 'npx ', 'node ', 'git ', 'gh ', 'cat ', 'ls ', 'rg ', 'find ',
];

function safePath(p) {
  const abs = path.resolve(REPO_ROOT, p);
  if (!abs.startsWith(REPO_ROOT)) throw new Error(`Path outside repo: ${p}`);
  if (/(^|\/)(\.env|\.env\..*)$/.test(p)) throw new Error(`Edits to .env files are forbidden`);
  return abs;
}

function makeTools({ runId, repo, dryRun }) {
  const editedPaths = new Set();

  const defs = [
    {
      name: 'read_file',
      description: 'Read a file from the repo. Use to understand code before editing.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'list_dir',
      description: 'List contents of a directory.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    {
      name: 'grep',
      description: 'Search for a regex pattern in the repo. Returns up to 100 matches.',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, glob: { type: 'string' } },
        required: ['pattern'],
      },
    },
    {
      name: 'write_file',
      description: 'Write/overwrite a file. Always reads-then-writes; you must understand the file first.',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    {
      name: 'run_command',
      description: 'Run a whitelisted shell command (npm/npx/node/git/gh/cat/ls/rg/find). Returns stdout+stderr, exit code.',
      input_schema: {
        type: 'object',
        properties: { cmd: { type: 'string' }, timeout_sec: { type: 'integer' } },
        required: ['cmd'],
      },
    },
    {
      name: 'query_backlog',
      description: 'Get current backlog: GH issues labeled engineer:next, TODOs, ambition seeds, task hint.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'gh_pr_create',
      description: 'Create a pull request from the current branch. Returns PR number + URL + auto-merge eligibility.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          base: { type: 'string' },
        },
        required: ['title', 'body'],
      },
    },
    {
      name: 'gh_pr_enable_automerge',
      description: 'Enable auto-merge on a PR (only call after gh_pr_create returns risk=low).',
      input_schema: {
        type: 'object',
        properties: { pr: { type: 'integer' }, method: { type: 'string', enum: ['squash', 'merge', 'rebase'] } },
        required: ['pr'],
      },
    },
    {
      name: 'whatsapp_ping_doctor',
      description: 'Notify Dr. Anirudh on WhatsApp about a PR needing review or an escalation.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' }, link: { type: 'string' } },
        required: ['title', 'body'],
      },
    },
    {
      name: 'log_decision',
      description: 'Record an action this agent took. Always call before finishing.',
      input_schema: {
        type: 'object',
        properties: {
          action_type: { type: 'string' },
          target_table: { type: 'string' },
          target_id: { type: 'string' },
          payload: { type: 'object' },
          requires_approval: { type: 'boolean' },
          executed: { type: 'boolean' },
        },
        required: ['action_type'],
      },
    },
    {
      name: 'add_digest_item',
      description: 'Add a row to the daily digest the doctor reviews each morning.',
      input_schema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'warn', 'error'] },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['category', 'title'],
      },
    },
  ];

  const impls = {
    read_file: ({ path: p }) => {
      const abs = safePath(p);
      if (!fs.existsSync(abs)) return { error: 'not_found' };
      const content = fs.readFileSync(abs, 'utf8');
      if (content.length > 200_000) return { error: 'file_too_large', size: content.length };
      return { content };
    },
    list_dir: ({ path: p }) => {
      const abs = safePath(p);
      if (!fs.existsSync(abs)) return { error: 'not_found' };
      return { entries: fs.readdirSync(abs).slice(0, 500) };
    },
    grep: ({ pattern, glob }) => {
      try {
        const args = ['rg', '-n', '--max-count', '100'];
        if (glob) args.push('-g', JSON.stringify(glob));
        args.push(JSON.stringify(pattern));
        const out = execSync(args.join(' '), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO_ROOT });
        return { matches: out.split('\n').slice(0, 200).join('\n') };
      } catch (err) {
        return { matches: '', note: 'no matches or error', stderr: (err.stderr || '').toString().slice(0, 500) };
      }
    },
    write_file: ({ path: p, content }) => {
      const abs = safePath(p);
      if (dryRun) return { ok: true, dryRun: true, path: p, bytes: content.length };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      editedPaths.add(p);
      return { ok: true, path: p, bytes: content.length };
    },
    run_command: ({ cmd, timeout_sec }) => {
      const allowed = ALLOWED_CMD_PREFIXES.some(pre => cmd.startsWith(pre));
      if (!allowed) return { error: 'command_not_whitelisted', cmd };
      if (/--no-verify|rm -rf|curl |wget |sudo /i.test(cmd)) return { error: 'forbidden_token_in_cmd' };
      try {
        const out = execSync(cmd, {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          timeout: (timeout_sec || 120) * 1000,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
        });
        return { ok: true, stdout: out.slice(0, 50_000) };
      } catch (err) {
        return {
          ok: false,
          exit_code: err.status,
          stdout: (err.stdout || '').toString().slice(0, 25_000),
          stderr: (err.stderr || '').toString().slice(0, 25_000),
        };
      }
    },
    query_backlog: () => getBacklog({ repo, taskHint: process.env.TASK_HINT }),
    gh_pr_create: ({ title, body, base }) => {
      if (dryRun) return { ok: true, dryRun: true, pr: 0, url: 'dry-run', risk: classifyPaths([...editedPaths]).risk };
      try {
        const baseBranch = base || 'main';
        execSync(`git push -u origin HEAD`, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        const { risk, highHits } = classifyPaths([...editedPaths]);
        const labels = risk === 'high' ? '--label "risk:high" --label "agent"' : '--label "risk:low" --label "agent"';
        const bodyFile = path.join(REPO_ROOT, '.pr-body.tmp.md');
        fs.writeFileSync(bodyFile, body);
        const out = execSync(
          `gh pr create --base ${baseBranch} --title ${JSON.stringify(title)} --body-file ${bodyFile} ${labels}`,
          { encoding: 'utf8', cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        fs.unlinkSync(bodyFile);
        const url = out.trim().split('\n').pop();
        const pr = parseInt(url.split('/').pop(), 10);
        return { ok: true, pr, url, risk, highRiskPaths: highHits };
      } catch (err) {
        return { ok: false, error: err.message, stderr: (err.stderr || '').toString().slice(0, 2000) };
      }
    },
    gh_pr_enable_automerge: ({ pr, method }) => {
      if (dryRun) return { ok: true, dryRun: true };
      const { risk } = classifyPaths([...editedPaths]);
      if (risk === 'high') return { ok: false, error: 'auto_merge_blocked_high_risk_paths' };
      try {
        execSync(`gh pr merge ${pr} --auto --${method || 'squash'}`, {
          cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    whatsapp_ping_doctor: ({ title, body, link }) => pingDoctor({ title, body, link }),
    log_decision: (args) => logDecision(runId, {
      actionType: args.action_type,
      targetTable: args.target_table,
      targetId: args.target_id,
      payload: args.payload,
      requiresApproval: args.requires_approval,
      executed: args.executed,
    }).then(d => ({ ok: true, id: d.id.toString() })),
    add_digest_item: (args) => addDigestItem({
      category: args.category,
      severity: args.severity,
      title: args.title,
      detail: args.detail,
      agentRunId: runId,
    }).then(d => ({ ok: true, id: d.id.toString() })),
  };

  return { defs, impls, editedPaths };
}

module.exports = { makeTools };
