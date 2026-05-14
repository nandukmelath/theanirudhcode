// Backlog source for the engineer agent.
// Pulls from: GitHub issues labeled engineer:next, TODO/FIXME scan, optional task hint.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function listLabeledIssues(repo, label = 'engineer:next', limit = 20) {
  if (!repo) return [];
  try {
    const json = execSync(
      `gh issue list --repo ${repo} --label "${label}" --state open --limit ${limit} --json number,title,body,labels,url`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function scanTodos(rootDirs = ['src', 'server.js', 'agents']) {
  const hits = [];
  const re = /\b(TODO|FIXME|XXX|HACK)\b[: ]?(.*)/;
  function walk(p) {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (p.includes('node_modules') || p.endsWith('.git')) return;
      for (const f of fs.readdirSync(p)) walk(path.join(p, f));
      return;
    }
    if (!/\.(js|ts|html|css)$/i.test(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) hits.push({ file: p, line: i + 1, kind: m[1], text: m[2].trim() });
      if (hits.length >= 200) return;
    }
  }
  for (const d of rootDirs) walk(d);
  return hits;
}

function getBacklog({ repo, taskHint }) {
  return {
    taskHint: taskHint || null,
    labeledIssues: listLabeledIssues(repo),
    todos: scanTodos(),
    seedAmbitions: [
      'Run prisma/migrate-account-lockout.js + prisma/migrate-agents.js on live DB if not already applied',
      'Extract inline <script> blocks from views/*.html into external files; tighten CSP to remove unsafe-inline',
      'Add audit_log table + middleware to log all admin actions (Phase 5)',
      'Add pagination to /portal-management admin list endpoints',
      'Add Sentry or equivalent error tracking to server.js + flush in shutdown handler',
      'Write integration test: signup -> verify email -> login -> book -> cancel',
      'Rotate suspected leaked secrets from old .env commits (document rotation in /docs/security.md)',
      'Add CSAT survey email 24h after completed appointment',
      'Add structured data (JSON-LD) for medical practice on landing page',
    ],
  };
}

module.exports = { getBacklog, scanTodos, listLabeledIssues };
