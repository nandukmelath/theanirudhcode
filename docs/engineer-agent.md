# Engineer Agent — Runbook

The Engineer Agent runs nightly via GitHub Actions and opens pull requests improving the codebase autonomously. This doc is how Dr. Anirudh + collaborators operate, debug, and pause it.

## What it does
- Reads backlog (GH issues labeled `engineer:next`, TODO/FIXME scan, seed ambitions, optional `task_hint`).
- Picks ONE task per run.
- Branches off `main` as `agent/run-<runid>`.
- Edits files, runs lint + tests, opens a PR.
- LOW risk + green checks → auto-merge (squash).
- HIGH risk (auth/admin/payments/middleware/schema/migrations/workflows/Dockerfile/server.js) → no auto-merge, pings Dr. Anirudh on WhatsApp with PR link.
- Logs to `agent_runs`, `agent_decisions`, `digest_items` (Supabase).

## Schedule
- Cron: `30 20 * * *` UTC = 02:00 IST daily.
- Manual: GitHub → Actions → Engineer Agent → Run workflow. Provide `task_hint` to steer it, or `dry_run=true` for a no-op rehearsal.

## Required GitHub Secrets
| Secret | What |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (Console → Anthropic) |
| `DATABASE_URL` | Supabase pooled connection (matches Railway env) |
| `DIRECT_URL` | Supabase direct connection (Prisma migrations) |
| `WHATSAPP_ACCESS_TOKEN` | Meta WA Cloud API token |
| `WHATSAPP_PHONE_ID` | Meta WA business phone id |
| `DOCTOR_WHATSAPP` | Phone with country code, no +, e.g. `91XXXXXXXXXX` |
| `AGENT_GH_TOKEN` | Optional PAT with `repo` scope if default `GITHUB_TOKEN` lacks rights for PR + auto-merge. Recommended. |

## Cost controls
- Per-day cap: `AGENT_COST_CAP_USD` env in workflow (default $5/day).
- Per-run cap: hardcoded `min(cap - todays_spend, $3)`.
- Tokens-out per turn: 8000 max.
- Max turns per run: 40.
- Job timeout: 45 min.

Adjust `AGENT_COST_CAP_USD` in `.github/workflows/engineer-agent.yml`.

## How to pause the agent
- GitHub → Actions → Engineer Agent → ⋯ → Disable workflow.
- OR push a commit with the workflow disabled at top: `on: workflow_dispatch:` only (remove the `schedule:` block).

## How to steer the agent
- Open a GH issue. Label it `engineer:next`. Agent prefers labeled issues over scanned TODOs.
- For one-off: workflow_dispatch with `task_hint`: e.g. "Add Sentry to server.js; use SENTRY_DSN env var".

## Branch & path policy
- HIGH_RISK_PATTERNS (in `agents/engineer/safelist.js`):
  - `src/middleware/*`, `src/controllers/auth*`, `src/controllers/admin*`, `src/controllers/payments*`
  - `src/services/auth*`, `prisma/schema.prisma`, `prisma/migrate-*`
  - `.env*`, `server.js`, `railway.toml`, `Dockerfile`, `.github/workflows/*`
- Touching ANY of those → PR opened but auto-merge blocked, doctor pinged.

## Observability
- DB tables:
  - `agent_runs` — per-run status, cost, tokens, parent chain.
  - `agent_decisions` — concrete actions taken (one per PR usually).
  - `digest_items` — rows aggregated into the daily 8 AM IST digest.
- Logs: GH Actions job logs (90-day retention by default).
- Query daily spend:
  ```sql
  SELECT date_trunc('day', started_at) AS day,
         SUM(cost_usd) AS spend,
         COUNT(*) AS runs
  FROM agent_runs
  WHERE agent_name='engineer'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
  ```

## When things go wrong
- **Cost cap hit**: Agent exits cleanly with `status=partial`. Bump cap or wait for next day.
- **Tests fail in agent's PR**: Auto-merge blocked by CI. PR stays open for manual review.
- **HIGH risk PR sits unmerged**: Doctor reviews via WhatsApp link, merges manually.
- **Agent stuck in a loop**: 40-turn cap + 45-min job timeout kill it. Inspect `agent_runs.output.stopReason`.
- **Bad PR landed via auto-merge**: Revert via `gh pr revert <pr>` or `git revert <sha>`. Then add path to HIGH_RISK_PATTERNS so it doesn't repeat.

## Deploy
This site auto-deploys from `main` via Railway. Auto-merged PRs ship to production within minutes.
**If you need a freeze**: temporarily disable Railway → Settings → Deployments → Pause, OR disable the engineer workflow.
