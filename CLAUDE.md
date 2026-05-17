# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                    # run all tests (vitest)
npm test -- tests/server/routes-auth.test.js  # run a single test file
npm run build:ui            # rebuild frontend bundle (esbuild + tailwind)
npm start                   # start the alphaclaw server
```

**After UI changes:** the compiled bundle in `lib/public/dist/` is committed to git (pre-built for Railway/GitHub deploys). After editing frontend source, rebuild and force-add before committing:
```bash
npm run build:ui
git add -f lib/public/dist/app.bundle.js lib/public/css/tailwind.generated.css
```

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

The production-close local dev environment lives in a sibling project at `../openclaw-railway-template/`. It runs the same Docker image and entrypoint as Railway, with the local `alpha-claw/src/` volume-mounted over the installed npm package for fast iteration.

**First-time setup (one-time):**
```bash
cd ../openclaw-railway-template
# Pull API keys + config from the live Railway deployment into data-seed/.env
# then seed the Docker volume and start:
npm run dev:seed   # copies data-seed/.env into the Docker volume
npm run dev        # builds image and starts container on port 3001
# Visit http://localhost:3001 and complete the setup wizard
```

**Daily dev loop:**
```bash
cd ../openclaw-railway-template
npm run dev          # start (skips rebuild if image exists, use --build to force)
npm run dev:restart  # pick up server-side changes in alpha-claw/src (~2s, no rebuild)
npm run dev:logs     # tail full logs (nothing filtered)
npm run dev:shell    # bash into the running container
```

**Credentials for local instance:**
- Dashboard: http://localhost:3001, password `62875094`
- Telegram bot: `@alphaclaw_dev_bot` (paired to user 7374876027)
- Model: `deepseek/deepseek-v4-pro`
- Workspace repo: `iamsteveng/openclaw-dev`

**Port 3000 conflict:** `PORT=3001` is set in `openclaw-railway-template/.env` because port 3000 is occupied by another local service.

**Known dev-only quirk:** `usage-tracker` plugin is blocked (uid=1000 vs root) — harmless, only affects that plugin.

**Syncing model API key and primary model from the Railway instance:**
```bash
RAILWAY_URL="https://openclaw-railway-template-production-a7f6.up.railway.app"

# 1. Login to Railway alphaclaw to pull keys
curl -s -c /tmp/railway-cookies.txt -X POST "$RAILWAY_URL/api/auth/login" \
  -H "Content-Type: application/json" -d '{"password":"62875094"}'

# 2. Extract the key you want (e.g. DEEPSEEK_API_KEY)
KEY=$(curl -s -b /tmp/railway-cookies.txt "$RAILWAY_URL/api/env" | \
  python3 -c "import json,sys; [print(v['value']) for v in json.load(sys.stdin)['vars'] if v['key']=='DEEPSEEK_API_KEY']")

# 3. Set it in the local instance
curl -s -b /tmp/alphaclaw-cookies.txt -X PUT http://localhost:3001/api/env \
  -H "Content-Type: application/json" \
  -d "{\"vars\":[{\"key\":\"DEEPSEEK_API_KEY\",\"value\":\"$KEY\"}]}"

# 4. Get primary model from Railway
MODEL=$(curl -s -b /tmp/railway-cookies.txt "$RAILWAY_URL/api/models/status" | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['modelKey'])")

# 5. Set it locally
curl -s -b /tmp/alphaclaw-cookies.txt -X POST http://localhost:3001/api/models/set \
  -H "Content-Type: application/json" -d "{\"modelKey\":\"$MODEL\"}"

# 6. Restart container to apply env change + reload gateway with new model
cd ../openclaw-railway-template && npm run dev:restart
```

**Sending a test message to the main agent via API:**
```bash
# Login first to get session cookie
curl -s -c /tmp/alphaclaw-cookies.txt -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" -d '{"password":"62875094"}'
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

Railway deploys directly from this GitHub repo. There is no build step on Railway — it runs `npm start` which calls `node bin/alphaclaw.js start`. The UI bundle (`lib/public/dist/app.bundle.js`) and generated CSS must be **committed to git** before pushing, otherwise Railway serves the old bundle.

**Deploy flow for code changes:**
1. Edit source files
2. `npm run build:ui` — rebuild the bundle
3. `git add -f lib/public/dist/app.bundle.js lib/public/css/tailwind.generated.css` — force-add (both are gitignored)
4. Commit and push to `main`
5. Railway auto-redeploys on push

**Required env vars on Railway:**

| Variable | Description |
|---|---|
| `SETUP_PASSWORD` | Password for the dashboard |
| `GITHUB_TOKEN` | GitHub PAT for workspace repo sync |
| `GITHUB_WORKSPACE_REPO` | `owner/repo` for workspace sync |

**Note:** Railway's Trial plan can cause OOM crashes — Hobby plan (8 GB RAM) is required for stable operation.

## Claude Code Authentication

`claude setup-token` (run on the user's local machine) generates a `sk-ant-oat01-...` token — this is the primary recommended auth method for cloud deployments. The token is validated against `api.anthropic.com/v1/models` before storage.

The OAuth PKCE flow uses:
- Authorize: `https://claude.com/cai/oauth/authorize`
- Token: `https://console.anthropic.com/v1/oauth/token`
- Redirect URI: `http://localhost:44889/callback` (any localhost port is accepted per RFC 8252)
- Scope: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- The `code=true` query param is required in the authorize URL (matches what the CLI sends)
