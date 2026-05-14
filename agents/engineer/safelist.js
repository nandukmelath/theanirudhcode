// Path-based risk classification for the engineer agent.
// HIGH risk → no auto-merge, escalate to doctor.
// LOW risk + tests pass → auto-merge enabled.

const HIGH_RISK_PATTERNS = [
  /(^|\/)src\/middleware\//i,
  /(^|\/)src\/controllers\/auth/i,
  /(^|\/)src\/controllers\/admin/i,
  /(^|\/)src\/controllers\/payments/i,
  /(^|\/)src\/services\/auth/i,
  /prisma\/schema\.prisma$/i,
  /prisma\/migrate-/i,
  /\.env/i,
  /server\.js$/i,
  /(^|\/)railway\.toml$/i,
  /(^|\/)Dockerfile$/i,
  /(^|\/)\.github\/workflows\//i,
];

function classifyPaths(paths) {
  let risk = 'low';
  const highHits = [];
  for (const p of paths) {
    for (const re of HIGH_RISK_PATTERNS) {
      if (re.test(p)) { risk = 'high'; highHits.push(p); break; }
    }
  }
  return { risk, highHits };
}

function canAutoMerge(paths) {
  return classifyPaths(paths).risk === 'low';
}

module.exports = { classifyPaths, canAutoMerge, HIGH_RISK_PATTERNS };
