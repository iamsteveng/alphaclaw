# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                    # run all tests (vitest)
npm test -- tests/server/routes-auth.test.js  # run a single test file
npm run build:ui            # rebuild frontend bundle (esbuild + tailwind) — local dev only
npm start                   # start the alphaclaw server
npm run dev                 # start local Docker Compose environment
npm run dev:restart         # pick up server-side changes without rebuild (~2s)
```

**After UI changes (local dev):** the bundle is built into the Docker image, so a rebuild is needed:
```bash
npm run build:ui && docker compose up --build -d   # rebuild image with new bundle
```

**Server-side changes** (lib/server/, lib/setup/): volume-mounted, so `npm run dev:restart` picks them up in ~2s without a rebuild.

**Railway deploys:** the UI bundle is built inside the Docker image automatically — no manual bundle commits needed.

**Before running tests in a fresh checkout:** run `npm install` first — `vitest` is a devDependency.

## Architecture

AlphaClaw is a management harness for OpenClaw. It provides a browser-based setup UI, gateway lifecycle management, a self-healing watchdog, and integrations (Telegram, Discord, Google Workspace, webhooks, cron, etc.) so OpenClaw can be operated entirely through a browser.

**Runtime model:**
1. `bin/alphaclaw.js` is the CLI entry. `alphaclaw start` boots the Express server.
2. The Express server spawns and manages an OpenClaw gateway process as a child (`lib/server/gateway.js`).
3. The setup UI calls AlphaClaw's own Express APIs for configuration and operations.
4. AlphaClaw reverse-proxies non-API traffic to the OpenClaw gateway (`lib/server/routes/proxy.js`).
5. The watchdog (`lib/server/watchdog.js`) monitors the gateway, detects crashes, runs `openclaw doctor --fix`, and sends notifications.

**Key directories:**
- `bin/alphaclaw.js` — CLI, flag parsing, environment setup, starts Express server
- `lib/server/constants.js` — all shared constants and file paths (single source of truth)
- `lib/server/init/register-server-routes.js` — mounts all route modules onto the Express app
- `lib/server/routes/` — one module per feature area (auth, models, claude-code, codex, webhooks, etc.)
- `lib/server/startup.js` — boot sequence after onboarding is confirmed
- `lib/server/auth-profiles.js` — stores OAuth credentials for Codex, Claude Code, etc.
- `lib/server/db/` — SQLite-backed persistence (usage, watchdog, webhooks)
- `lib/public/js/app.js` — frontend entry; Preact + `htm` (no JSX transpilation)
- `lib/public/js/lib/api.js` — all frontend API functions (fetch wrappers)
- `lib/public/js/components/` — UI components organized by tab/feature
- `lib/public/js/hooks/` — shared hooks (`use-cached-fetch`, `use-polling`, etc.)

**Storage root:** `~/.alphaclaw/` (override with `ALPHACLAW_ROOT_DIR`). Credentials, env file, gateway config, and OpenClaw workspace all live under this directory.

## Frontend Patterns

The frontend uses Preact with `htm` (tagged template literals, no build-time JSX). Components use `html\`...\`` syntax.

**Data fetching:**
- Use `useCachedFetch` from `lib/public/js/hooks/use-cached-fetch.js` for component-level reads — not raw `useEffect` + fetch.
- Use `cachedFetch` / `getCached` / `setCached` / `invalidateCache` from `lib/public/js/lib/api-cache.js` for imperative paths.
- Use `usePolling` for recurring refreshes; always pass a stable `cacheKey`.

## Server Patterns

- All route modules export a `register*Routes({ app, ...deps })` function and are mounted via `register-server-routes.js`.
- `lib/server/constants.js` contains all file paths, ports, OAuth constants, and feature flags. Add new constants here rather than inline in route files.
- The `authProfiles` object (from `auth-profiles.js`) is injected into route modules that need to read/write OAuth credentials.
- File-based state (auth state, credentials) lives under `ALPHACLAW_ROOT_DIR`; DB-backed state lives in `lib/server/db/`.

## Local Container Testing

The production-close local dev environment runs directly from this repo using Docker Compose. It builds the same Docker image as Railway, with local source volume-mounted for fast iteration (no rebuild for server-side changes).

**First-time setup (one-time):**
```bash
# Pull API keys + config from the live Railway deployment into data-seed/.env
railway run cat /data/.env > data-seed/.env  # requires railway CLI + auth

# Seed the Docker volume and start:
npm run dev:seed   # copies data-seed/.env into the Docker volume
npm run dev        # builds image and starts containers on port 3000
# Visit http://localhost:3000 and complete the setup wizard
```

**Daily dev loop:**
```bash
npm run dev          # start (skips rebuild if image exists, use --build to force)
npm run dev:restart  # pick up server-side changes (~2s, no rebuild needed)
npm run dev:logs     # tail full logs (nothing filtered)
npm run dev:shell    # bash into the running container
```

**Credentials for local instance:**
- Dashboard: http://localhost:3000, password from `SETUP_PASSWORD` in your local `.env` file
- Telegram bot: `@alphaclaw_dev_bot` (paired to user 7374876027)
- Model: `deepseek/deepseek-v4-pro`
- Workspace repo: `iamsteveng/openclaw-dev`

**Port conflict:** set `PORT=3001` in your local `.env` if port 3000 is in use.

**Known dev-only quirk:** `usage-tracker` plugin is blocked (uid=1000 vs root) — harmless, only affects that plugin.

**Syncing model API key and primary model from the Railway instance:**
```bash
RAILWAY_URL="https://openclaw-railway-template-production-a7f6.up.railway.app"

# 1. Login to Railway alphaclaw to pull keys
curl -s -c /tmp/railway-cookies.txt -X POST "$RAILWAY_URL/api/auth/login" \
  -H "Content-Type: application/json" -d "{\"password\":\"$SETUP_PASSWORD\"}"

# 2. Extract the key you want (e.g. DEEPSEEK_API_KEY)
KEY=$(curl -s -b /tmp/railway-cookies.txt "$RAILWAY_URL/api/env" | \
  python3 -c "import json,sys; [print(v['value']) for v in json.load(sys.stdin)['vars'] if v['key']=='DEEPSEEK_API_KEY']")

# 3. Set it in the local instance
curl -s -b /tmp/alphaclaw-cookies.txt -X PUT http://localhost:3000/api/env \
  -H "Content-Type: application/json" \
  -d "{\"vars\":[{\"key\":\"DEEPSEEK_API_KEY\",\"value\":\"$KEY\"}]}"

# 4. Get primary model from Railway
MODEL=$(curl -s -b /tmp/railway-cookies.txt "$RAILWAY_URL/api/models/status" | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['modelKey'])")

# 5. Set it locally
curl -s -b /tmp/alphaclaw-cookies.txt -X POST http://localhost:3000/api/models/set \
  -H "Content-Type: application/json" -d "{\"modelKey\":\"$MODEL\"}"

# 6. Restart container to apply env change + reload gateway with new model
npm run dev:restart
```

**Sending a test message to the main agent via API:**
```bash
# Login first to get session cookie
curl -s -c /tmp/alphaclaw-cookies.txt -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" -d "{\"password\":\"$SETUP_PASSWORD\"}"
# Send message
curl -s -b /tmp/alphaclaw-cookies.txt -X POST http://localhost:3001/api/agent/message \
  -H "Content-Type: application/json" \
  -d '{"message":"your message here","sessionKey":"agent:main:main"}'
```

**Approving a Telegram pairing request:**
Use the pairings API (not the CLI — the CLI can't see the gateway's in-memory state):
```bash
curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/pairings   # list pending
curl -s -b /tmp/alphaclaw-cookies.txt -X POST http://localhost:3001/api/pairings/<id>/approve \
  -H "Content-Type: application/json" -d '{}'
```

## Deploying to Railway

Railway deploys directly from this GitHub repo using the `Dockerfile` at the repo root. The UI bundle is built inside the Docker image — no pre-built bundle needs to be committed to git.

**Deploy flow for code changes:**
1. Edit source files
2. Commit and push to `main`
3. Railway auto-redeploys on push (builds the Docker image, including `npm run build:ui`)

**Note:** Railway must be connected to `iamsteveng/alpha-claw` (not the old `openclaw-railway-template` repo). See `railway.toml` at the repo root for build configuration.

**Required env vars on Railway:**

| Variable | Description |
|---|---|
| `SETUP_PASSWORD` | Password for the dashboard |
| `GITHUB_TOKEN` | GitHub PAT for workspace repo sync |
| `GITHUB_WORKSPACE_REPO` | `owner/repo` for workspace sync |

**Note:** Railway's Trial plan can cause OOM crashes — Hobby plan (8 GB RAM) is required for stable operation.

## Adding OpenClaw Workspace Skills

AlphaClaw can bundle agent skills that are automatically seeded into the OpenClaw workspace on every startup. These appear to the agent as `openclaw-workspace` skills.

**How it works:**
1. Place the skill directory under `lib/setup/skills/<skill-name>/`
2. `syncWorkspaceSkills` (called in `syncBootstrapPromptFiles`) copies all files to `workspace/skills/<skill-name>/` on every alphaclaw startup
3. The OpenClaw gateway discovers the skill via `resolvePluginSkillDirs`, which scans `<workspaceDir>/skills/`
4. The agent sees it in its `<available-skills>` context on new sessions

**Required file:**
```
lib/setup/skills/<skill-name>/
  SKILL.md          ← required: name + description frontmatter, usage instructions
  <support files>   ← optional: scripts, references, etc.
```

`SKILL.md` frontmatter fields and why they matter:

```yaml
---
name: my-skill-name
description: One-line description the agent sees when deciding to invoke this skill.
triggers:
  - keyword or phrase that invokes this skill
  - another trigger phrase
---
```

| Field | Required | Purpose |
|---|---|---|
| `name` | Yes | Identifies the skill in `<available-skills>`. Must match the directory name. Used when the agent is told to invoke the skill by name. |
| `description` | Yes | Shown alongside `name` in the agent's context. The agent reads this to decide whether the skill is relevant to a request. A vague description means the skill gets ignored. |
| `triggers` | Strongly recommended | A list of phrases or keywords that cause the agent to automatically invoke the skill without being told explicitly. **If omitted, the skill can only be called by name — the agent will not discover it based on the content of a cron message or conversation.** Match trigger phrases to the exact language used in cron job messages and user prompts that should invoke this skill. |

**Trigger matching is how cron jobs reliably invoke skills** — the cron message doesn't need to say "use skill X"; it just needs to contain a phrase listed in `triggers`. See the "Writing Cron / Agent Messages" section below for the complementary rule: cron message wording must match the skill's `triggers`.

**Key gotchas learned the hard way:**
- **Do NOT write symlinks into `~/.openclaw/plugin-skills/`** — the gateway fully owns that directory and resets it on startup. Any manually created symlinks will be wiped.
- **`openclaw skills list` (CLI) vs gateway** — the CLI runs with `HOME=/root`, the gateway runs with `HOME=/data`. `openclaw skills list` from a shell won't show workspace skills; use `HOME=/data openclaw skills list` to see what the gateway sees.
- **Existing sessions cache skills at session start** — after adding a new skill, the agent won't see it until a fresh session. Test with a new `openclaw agent --message "..."` call (no `--session-id`).
- **TOOLS.md is for platform/integration docs only** — skill-specific docs belong in `SKILL.md`, not appended to `lib/setup/core-prompts/TOOLS.md`.

**Verifying skill discovery:**
```bash
# From inside the container:
HOME=/data openclaw skills list | grep <skill-name>

# Test with fresh agent session:
docker exec <container> openclaw agent --agent main --message "use my-skill-name"
```

## Writing Cron / Agent Messages That Reliably Trigger Behaviors

When writing instructions in cron job content or SKILL.md, if there is a target skill to be triggered, make sure the instruction matches with the `triggers` frontmatter in the target skill.

**Iterating on a message before wiring it to a cron:**

```bash
# Test the message directly — bypasses cron scheduling, output visible immediately
docker exec <container> bash -c "HOME=/data openclaw agent --agent main \
  --message 'your message here' 2>/dev/null"

# Pass a multi-line message via a temp file to avoid shell-quoting issues
cat > /tmp/msg.txt << 'EOF'
Step 1: Run gbrain list...
Step 2: ...
EOF
docker exec -i <container> bash -c "HOME=/data openclaw agent --agent main \
  --message \"$(cat /tmp/msg.txt | sed 's/\"/\\\"/g')\"" 2>/dev/null
```

**Message structure that works reliably:**

1. Open with `"<task name> — execute now, no confirmation needed."` — prevents the agent asking for permission.
2. Use numbered steps. The agent executes them sequentially.
3. For writes: include `gbrain restore <slug> 2>/dev/null` **before** `gbrain put <slug>` — GBrain's `put` on a soft-deleted page updates the content but does **not** restore page visibility. Without the restore step the agent's writes become invisible.
4. End with `"Output ONLY the formatted report — no questions, no follow-ups."` to prevent the agent asking where to send the output.

**Soft-deleted GBrain pages:**

```bash
# put on a soft-deleted page → content updated but page stays invisible to gbrain list/get
gbrain put plans/aapl       # ❌ page still soft-deleted, agent can't see it

# Always restore first:
gbrain restore plans/aapl 2>/dev/null || true
gbrain put plans/aapl       # ✅ page visible after this
```

In cron messages tell the agent: `"first run: gbrain restore plans/<slug> 2>/dev/null, then gbrain put plans/<slug>"`.

## GBrain in Integration Tests

The container's `gbrain` CLI uses a different pglite database than the host's `gbrain`:

| Context | Database path |
|---|---|
| Host `gbrain` | `/home/ubuntu/.gbrain/brain.pglite` |
| Container `gbrain` (docker exec or gateway) | `/root/.gbrain/brain.pglite` |

Tests that seed data with the host `gbrain` and assert with the host `gbrain` will always fail — the agent reads and writes the **container** database. Fix: override `gbrain` in test helpers to route through `docker exec`:

```bash
# In scripts/tests/helpers.sh — routes all gbrain calls into the container
gbrain() {
  if [[ "${1:-}" == "put" ]]; then
    docker exec -i "$CONTAINER" gbrain "$@"   # -i only for put (reads stdin)
  else
    docker exec "$CONTAINER" gbrain "$@"      # no -i; avoids consuming piped confirm stdin
  fi
}
```

Using `-i` on non-`put` subcommands is dangerous when the test runner pipes `y\ny` to stdin for confirm prompts — `docker exec -i` will consume those characters, causing later `read` calls to get no input and exit non-zero under `set -e`.

**GBrain YAML serialization gotcha:**

GBrain serializes `date:` fields as `date: '2026-06-04T00:00:00.000Z'` (single-quoted ISO string). Embedding this in a bash `eval "... '$VAR' ..."` check breaks the quote parsing. Use a temp file for any variable that may contain GBrain date fields:

```bash
# ❌ Breaks if $LEARNING contains  date: '2026-06-04T...'
LEARNING=$(gbrain get "learning/$TODAY")
check "page created" "[[ -n '$LEARNING' ]]"

# ✅ Safe — file path never contains quotes
LEARNING_FILE=$(mktemp)
gbrain get "learning/$TODAY" > "$LEARNING_FILE" 2>/dev/null || true
check "page created" "[[ -s \"$LEARNING_FILE\" ]]"
check "mentions AAPL"  "grep -qE 'AAPL|TSLA' \"$LEARNING_FILE\""
rm -f "$LEARNING_FILE"
```

## Troubleshooting Cron Job Failures via Chat History API

When a cron job fails, use these steps to pull the agent's chat history and diagnose the root cause.
Replace `$RAILWAY_URL` and `$SETUP_PASSWORD` with your instance values (see CLAUDE.md local dev section for local equivalent).

**Step 1 — Authenticate**
```bash
RAILWAY_URL="https://openclaw-railway-template-production-a7f6.up.railway.app"
SETUP_PASSWORD="<your password>"
curl -s -c /tmp/ac.txt -X POST "$RAILWAY_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$SETUP_PASSWORD\"}"
```

**Step 2 — List jobs, find the failing job's ID**
```bash
curl -s -b /tmp/ac.txt "$RAILWAY_URL/api/cron/jobs" | python3 -m json.tool
# Each job has: id, name, enabled, schedule, payload.message
```

**Step 3 — List recent runs, find the failed run's timestamp**
```bash
JOB_ID="<id from step 2>"
curl -s -b /tmp/ac.txt "$RAILWAY_URL/api/cron/jobs/$JOB_ID/runs?sortDir=desc" | python3 -m json.tool
# Each run has: ts (Unix ms), status ("ok" | "error"), error, durationMs
```

**Step 4 — Pull agent chat history for that run**
```bash
RUN_TS="<ts from step 3>"
curl -s -b /tmp/ac.txt "$RAILWAY_URL/api/cron/jobs/$JOB_ID/runs/$RUN_TS/chat-history" | python3 -m json.tool
# Response: { ok, sessionKey, run, messages: [{role, content}] }
```

**One-liner to scan all jobs for failures:**
```bash
curl -s -b /tmp/ac.txt "$RAILWAY_URL/api/cron/jobs" | python3 -c "
import json,sys,subprocess,os
jobs = json.load(sys.stdin).get('jobs',[])
for j in jobs:
    r = subprocess.run(['curl','-s','-b','/tmp/ac.txt',
        f'{os.environ[\"RAILWAY_URL\"]}/api/cron/jobs/{j[\"id\"]}/runs?sortDir=desc&limit=3'],
        capture_output=True, text=True)
    runs = json.loads(r.stdout).get('runs',{}).get('entries',[])
    for run in runs:
        if run.get('status') == 'error':
            print(f'FAIL  {j[\"name\"]}  ts={run[\"ts\"]}  error={run.get(\"error\")}')
"
```

**Known limitation — timeout failures have no chat history:**
When a job times out (`error: "cron: job execution timed out"`), the `sessionKey` in the run record is empty and `messages` will be `[]`. This means the agent did run but the session wasn't linked before the timeout killed the process. To diagnose timeout failures:
- Check if the job's `timeoutSeconds` in its payload is too low for the work it does.
- Simplify or split the job's prompt into smaller steps.
- Check gateway logs: `npm run dev:logs` (local) or Railway deployment logs for the relevant time window.

**Local instance equivalent:**
Replace `$RAILWAY_URL` with `http://localhost:3001` and use the local `$SETUP_PASSWORD` from `openclaw-railway-template/.env`.

## Claude Code Authentication

`claude setup-token` (run on the user's local machine) generates a `sk-ant-oat01-...` token — this is the primary recommended auth method for cloud deployments. The token is validated against `api.anthropic.com/v1/models` before storage.

The OAuth PKCE flow uses:
- Authorize: `https://claude.com/cai/oauth/authorize`
- Token: `https://console.anthropic.com/v1/oauth/token`
- Redirect URI: `http://localhost:44889/callback` (any localhost port is accepted per RFC 8252)
- Scope: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- The `code=true` query param is required in the authorize URL (matches what the CLI sends)
