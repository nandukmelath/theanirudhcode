# Engineer Agent — Setup Checklist

What this PR delivers: full scaffold for an autonomous nightly engineer agent. After merge, do the steps below in order. Each one is small.

## 0. Push workflow files (one-time, blocked by current git credential)
The cached git credential for this repo lacks the `workflow` OAuth scope, so the scaffold commit on `agent/scaffold-engineer` does NOT include `.github/workflows/ci.yml` and `.github/workflows/engineer-agent.yml` even though both files exist locally and are referenced by `docs/engineer-agent.md`.

To land them, choose one:

**Easiest — GitHub web UI (no auth changes):**
1. Open https://github.com/nandukmelath/theanirudhcode on the `agent/scaffold-engineer` branch.
2. Click `Add file → Create new file`.
3. Filename: `.github/workflows/ci.yml`. Paste the full contents from your local `C:\Users\nandu\theanirudhcode\.github\workflows\ci.yml`.
4. Commit directly to `agent/scaffold-engineer`.
5. Repeat for `.github/workflows/engineer-agent.yml`.

**Or — re-auth git with workflow scope:**
1. Create a fine-grained PAT at github.com → Settings → Developer settings → Personal access tokens. Scopes: `Contents: write`, `Workflows: write`, `Pull requests: write` on `nandukmelath/theanirudhcode`.
2. Remove the cached credential: `cmdkey /delete:git:https://github.com`.
3. `git push -u origin agent/scaffold-engineer` and paste the PAT as the password.

Both workflows live untracked in your local working tree until you push them.

## 1. Verify install
```powershell
cd C:\Users\nandu\theanirudhcode
npm install   # picks up @anthropic-ai/sdk@^0.32.1
```
Should report "0 vulnerabilities" and "added 15 packages" (done already as of 2026-05-14).

## 2. Migrate agent tables on LIVE Supabase DB
The local `.env` currently points `DATABASE_URL` at `localhost:5432` (a dev stub). For the migration to hit live Supabase:

Option A — temporary override (cleanest):
```powershell
$env:DATABASE_URL = "<paste pooled Supabase URL>"
$env:DIRECT_URL   = "<paste direct Supabase URL>"
node prisma/migrate-agents.js
Remove-Item Env:DATABASE_URL; Remove-Item Env:DIRECT_URL
```

Option B — Railway env: ssh into Railway shell and run `node prisma/migrate-agents.js` there (URLs already set).

You should see: `Migration complete. Tables created: agent_runs, agent_decisions, approval_queue, digest_items`.

Re-runnable. All statements use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.

## 3. GitHub Secrets — Settings → Secrets and variables → Actions → New repository secret

| Secret | Source | Required? |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys | YES |
| `DATABASE_URL` | Supabase pooled connection (same as Railway) | YES |
| `DIRECT_URL` | Supabase direct connection | YES |
| `AGENT_GH_TOKEN` | github.com → Settings → Developer settings → PAT (fine-grained), scope: `Contents: write`, `Pull requests: write` on this repo | YES (default `GITHUB_TOKEN` can't enable auto-merge on PRs it created) |
| `WHATSAPP_ACCESS_TOKEN` | Meta business → System users → token | Optional (no doctor pings without it) |
| `WHATSAPP_PHONE_ID` | Meta → WhatsApp → API setup | Optional |
| `DOCTOR_WHATSAPP` | Phone with country code, no `+` (e.g. `9198xxxxxxxx`) | Optional |
| `DATABASE_URL_TEST` | Local/throwaway Postgres for CI smoke test (or leave for stub fallback) | Optional |

## 4. Branch protection on `main`
Repo → Settings → Branches → Branch protection rule for `main`:
- ✅ Require status checks to pass before merging
- ✅ Required: `CI / lint-test`
- ✅ Require branches to be up to date before merging
- ⬜ Require pull request reviews (LEAVE UNCHECKED — agent has no human reviewer)
- ✅ Do not allow bypassing the above settings
- ✅ Restrict who can push to matching branches → only agent bot + you

Repo → Settings → General → Pull Requests → ✅ Allow auto-merge

## 5. Railway auto-deploy from `main`
Railway → theanirudhcode service → Settings → Source → Connect GitHub → repo → branch=`main` → Auto Deploy ✅.

Replaces the manual `railway up` flow from the existing memory. After this, any merge to `main` ships within ~3-5 min.

## 6. Local dry-run sanity check
```powershell
cd C:\Users\nandu\theanirudhcode
$env:ANTHROPIC_API_KEY = "<paste key>"
$env:GH_TOKEN = "<paste PAT>"
$env:REPO = "nandukmelath/theanirudhcode"
$env:DRY_RUN = "true"
npm run agent:engineer:dry
```

What to watch for in output:
- `[engineer-agent] run_id=...` — DB row created
- `cost cap: spent $0.0000` — cost guard working
- `stop=end_turn turns=...` — clean termination
- No errors writing to `agent_runs` / `digest_items`

If the run completes without writing to DB (e.g. Prisma points at localhost stub still): override `DATABASE_URL` for the dry run too.

## 7. First real run
GitHub → Actions → Engineer Agent → Run workflow → leave `dry_run` unchecked, `task_hint` blank → Run.

First successful real run will:
- Open `agent/run-<id>` branch
- Open a PR with one improvement from the backlog
- Either auto-merge (if LOW risk + CI green) or ping you on WhatsApp (if HIGH risk)

## 8. Steer day-to-day
- Add `engineer:next` label to any GH issue you want prioritized.
- One-off nudge: Actions → Engineer Agent → Run workflow → `task_hint = "Add Sentry to server.js using SENTRY_DSN env"`.

## Pause / stop
Actions → Engineer Agent → ⋯ → Disable workflow. OR delete the `schedule:` block in `.github/workflows/engineer-agent.yml`.

## Notes for this PR specifically
- This PR mixes the agent scaffold with current uncommitted WIP for `package.json`, `package-lock.json`, and `prisma/schema.prisma` (those files were already dirty when scaffold was authored). User profile fields, `EmailOtp` model, `cross-env` + `@playwright/test` devDeps are part of this commit — those came from your in-progress work, kept together to keep the build green.
- All other in-progress files (`server.js`, `src/controllers/*`, `views/*`, `public/js/*`, etc.) remain uncommitted on `refresh/v3-polish` untouched.
- Live DB migration (step 2) and GitHub Secrets (step 3) MUST be done before the first nightly cron fires, or the workflow will fail noisily (which is fine — no damage done).
