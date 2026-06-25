# Requirements: Combine Railway Template into alpha-claw (Issue #10)

## Goals

1. The `alpha-claw` repository is the single source of truth for both application code and Railway deployment configuration. The separate `openclaw-railway-template` repository is no longer required for any part of the deploy or local dev workflow.

2. Merging any PR to `alpha-claw` main — whether it touches application code or deployment configuration — automatically triggers a Railway redeployment with no manual steps.

3. Local development runs entirely from a single checkout of `alpha-claw` using Docker Compose, with the same Docker image that Railway builds and runs.

4. All workspace skills that currently live in `openclaw-railway-template/workspace-skills/` are moved into `alpha-claw` and automatically seeded to the OpenClaw workspace on startup (same as skills already in `lib/setup/skills/`).

5. The seeding script for local dev (equivalent to `openclaw-railway-template/scripts/seed.sh`) is available in `alpha-claw` so developers never need to clone the template repo for local setup.

---

## Verifications

> **Rule:** All checks below must be executed by scripts. No AI agent judgement.
> **Rule:** When an environment variable containing credentials is present (e.g. `RAILWAY_TOKEN`, `SETUP_PASSWORD`), the test must exercise the real external system and must fail if the system rejects the request. Silent skips are not allowed when credentials are available.

### V1 — Required deployment files present at repo root

```bash
#!/usr/bin/env bash
set -euo pipefail

fail=0

for f in Dockerfile railway.toml entrypoint.sh docker-compose.yml; do
  if [[ ! -f "$f" ]]; then
    echo "FAIL: $f not found at repo root"
    fail=1
  else
    echo "PASS: $f present"
  fi
done

exit $fail
```

### V2 — railway.toml contains required Railway fields

Railway uses these exact field names to configure the deployment. Source: [Railway Docs — Config as Code](https://docs.railway.com/reference/config-as-code).

```bash
#!/usr/bin/env bash
set -euo pipefail

fail=0

# [build] builder must be "DOCKERFILE" (exact enum value Railway accepts)
if ! grep -q 'builder = "DOCKERFILE"' railway.toml; then
  echo "FAIL: railway.toml missing [build] builder = \"DOCKERFILE\""
  fail=1
else
  echo "PASS: builder = DOCKERFILE"
fi

# healthcheckPath must be present so Railway knows when the container is ready
if ! grep -q 'healthcheckPath' railway.toml; then
  echo "FAIL: railway.toml missing healthcheckPath"
  fail=1
else
  echo "PASS: healthcheckPath present"
fi

# dockerfilePath must point to the Dockerfile at repo root
if ! grep -q 'dockerfilePath' railway.toml; then
  echo "FAIL: railway.toml missing dockerfilePath"
  fail=1
else
  echo "PASS: dockerfilePath present"
fi

exit $fail
```

### V3 — Dockerfile builds from local source without fetching from an external npm/GitHub package

```bash
#!/usr/bin/env bash
set -euo pipefail

docker build --no-cache -t alphaclaw-monorepo-test:ci .
echo "PASS: docker build exited 0"

# The image must NOT contain a reference to the old split-repo install path
if docker run --rm alphaclaw-monorepo-test:ci cat /app/package.json \
    | grep -q '"github:iamsteveng/alphaclaw'; then
  echo "FAIL: image still installs alphaclaw from external GitHub SHA (old split-repo pattern)"
  exit 1
fi
echo "PASS: no external GitHub SHA dependency in image"
```

### V4 — `alphaclaw` binary is available and runnable inside the built image

```bash
#!/usr/bin/env bash
set -euo pipefail

if ! docker run --rm alphaclaw-monorepo-test:ci alphaclaw --version; then
  echo "FAIL: alphaclaw --version failed inside the image"
  exit 1
fi
echo "PASS: alphaclaw --version succeeded"
```

### V5 — Container starts and health endpoint returns HTTP 200

`SETUP_PASSWORD` must be set; if it is set, any non-200 response must fail the test.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SETUP_PASSWORD:-}" ]]; then
  echo "SKIP WARNING: SETUP_PASSWORD not set — skipping live container test"
  echo "  Set SETUP_PASSWORD to a non-empty value to enable this check."
  exit 0
fi

CONTAINER_ID=$(docker run -d \
  -e SETUP_PASSWORD="$SETUP_PASSWORD" \
  -p 13000:3000 \
  alphaclaw-monorepo-test:ci)

cleanup() { docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Waiting up to 60s for /health to return 200..."
for i in $(seq 1 30); do
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:13000/health || echo "000")
  if [[ "$HTTP" == "200" ]]; then
    echo "PASS: /health returned 200 after ~$((i * 2))s"
    exit 0
  fi
  sleep 2
done

echo "FAIL: /health did not return 200 within 60s (last HTTP status: $HTTP)"
exit 1
```

### V6 — Railway deployment succeeds after push to main

Requires `RAILWAY_TOKEN` (service account token from Railway dashboard). If present, this check is mandatory — no skip allowed.

Railway CLI deployment status enum values (source: `railway deployment list --json` schema): `BUILDING`, `DEPLOYING`, `SUCCESS`, `FAILED`, `CRASHED`, `REMOVED`, `WAITING`.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_TOKEN:-}" ]]; then
  echo "SKIP WARNING: RAILWAY_TOKEN not set — Railway deployment check skipped."
  echo "  Set RAILWAY_TOKEN to enforce this check."
  exit 0
fi

# Ensure railway CLI is available
if ! command -v railway &>/dev/null; then
  echo "FAIL: 'railway' CLI not installed"
  exit 1
fi

echo "Polling Railway for latest deployment status (up to 10 minutes)..."
for i in $(seq 1 60); do
  STATUS=$(railway deployment list --json 2>/dev/null \
    | python3 -c "
import json, sys
deployments = json.load(sys.stdin)
if not deployments:
    print('NONE')
else:
    print(deployments[0]['status'])
")

  echo "  Attempt $i/60: status = $STATUS"

  if [[ "$STATUS" == "SUCCESS" ]]; then
    echo "PASS: Railway deployment status is SUCCESS"
    exit 0
  elif [[ "$STATUS" == "FAILED" || "$STATUS" == "CRASHED" ]]; then
    echo "FAIL: Railway deployment status is $STATUS"
    exit 1
  fi

  sleep 10
done

echo "FAIL: Railway deployment did not reach SUCCESS within 10 minutes"
exit 1
```

### V7 — Health endpoint on the live Railway URL returns 200

Requires `RAILWAY_URL` (e.g. `https://your-service.up.railway.app`). If present, mandatory.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_URL:-}" ]]; then
  echo "SKIP WARNING: RAILWAY_URL not set — live URL health check skipped."
  exit 0
fi

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$RAILWAY_URL/health")
if [[ "$HTTP" == "200" ]]; then
  echo "PASS: $RAILWAY_URL/health returned 200"
else
  echo "FAIL: $RAILWAY_URL/health returned $HTTP (expected 200)"
  exit 1
fi
```

### V8 — No secrets committed to the repository

```bash
#!/usr/bin/env bash
set -euo pipefail

fail=0

# Patterns that must not appear in any committed file
PATTERNS=(
  'SETUP_PASSWORD=[^$"\x27]'   # literal password value (not a shell variable ref)
  'GITHUB_TOKEN=gh[pos]_'      # actual GitHub token
  'sk-ant-'                    # Anthropic API key prefix
  'DEEPSEEK_API_KEY=[^$"\x27]' # literal DeepSeek key
)

for pat in "${PATTERNS[@]}"; do
  MATCHES=$(git grep -rE "$pat" -- ':!*.md' ':!tests/' ':!requirements/' 2>/dev/null || true)
  if [[ -n "$MATCHES" ]]; then
    echo "FAIL: secret pattern found: $pat"
    echo "$MATCHES"
    fail=1
  fi
done

# data-seed/.env must be gitignored (never committed)
if git ls-files --error-unmatch data-seed/.env 2>/dev/null; then
  echo "FAIL: data-seed/.env is tracked by git — it must be gitignored"
  fail=1
else
  echo "PASS: data-seed/.env is not tracked by git"
fi

[[ $fail -eq 0 ]] && echo "PASS: no secrets found in committed files"
exit $fail
```

### V9 — Local docker compose starts and reaches healthy state

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SETUP_PASSWORD:-}" ]]; then
  echo "SKIP WARNING: SETUP_PASSWORD not set — docker compose test skipped."
  exit 0
fi

export SETUP_PASSWORD

docker compose up -d --build

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Waiting up to 90s for docker compose services to become healthy..."
for i in $(seq 1 45); do
  STATUS=$(docker compose ps --format json 2>/dev/null \
    | python3 -c "
import json, sys
lines = [l for l in sys.stdin.read().strip().splitlines() if l]
services = [json.loads(l) for l in lines]
states = [s.get('State','') for s in services]
print(','.join(states))
" 2>/dev/null || echo "unknown")
  echo "  Attempt $i/45: states = $STATUS"
  if echo "$STATUS" | grep -qv "starting" && echo "$STATUS" | grep -q "running"; then
    echo "PASS: docker compose services are running"
    exit 0
  fi
  sleep 2
done

echo "FAIL: docker compose services did not reach running state within 90s"
exit 1
```

### V10 — `docker compose restart` completes within 15 seconds (no rebuild)

```bash
#!/usr/bin/env bash
set -euo pipefail

START=$(date +%s)
docker compose restart
END=$(date +%s)
ELAPSED=$((END - START))

if [[ $ELAPSED -le 15 ]]; then
  echo "PASS: docker compose restart completed in ${ELAPSED}s (<= 15s)"
else
  echo "FAIL: docker compose restart took ${ELAPSED}s (> 15s — may be rebuilding)"
  exit 1
fi
```

---

## Constraints

1. **Do not commit `data-seed/.env`** — it contains Railway credentials and must remain in `.gitignore`. Local dev seeding uses this file but it is never tracked by git.

3. **Do not change the Railway persistent volume path `/data`** — all existing Railway deployments store state at `/data` and `ALPHACLAW_ROOT_DIR=/data`. Changing this path would require a data migration on the live deployment.

4. **Do not change existing API route signatures** — routes under `/api/`, `/webhook/`, `/health`, etc. must continue to behave identically. The OpenClaw gateway proxy behaviour must be preserved.

5. **Do not modify the existing test suite** — files under `tests/` must not be deleted or structurally reorganised. Existing tests must continue to pass after the merge.

6. **Do not hardcode the Railway project URL or deployment ID** — these belong in environment variables or Railway CLI config, not in committed code.

7. **Do not change the entrypoint command** — the container's final command must remain `alphaclaw start` (or equivalent `node bin/alphaclaw.js start`) so Railway's health check and restart policy work as before.

---

## When You Need Human Feedback

### HF-1: Railway project must be manually repointed

The existing Railway service currently tracks `iamsteveng/openclaw-railway-template`. After `alpha-claw` contains `railway.toml` and `Dockerfile`, the Railway project must be repointed to `iamsteveng/alpha-claw` in the Railway dashboard (Settings → Source → change repo). This step cannot be automated in a PR and requires the project owner's Railway credentials.

**Tag: @iamsteveng** — please confirm which Railway service / project ID this applies to, and whether the repo connection should be switched before or after the template repo is archived.

### HF-2: `openclaw-railway-template` repo disposition

Once the migration is verified working, the template repo should either be archived or deleted. The PR author cannot archive or delete another repo without explicit approval.

**Tag: @iamsteveng** — after V6 and V7 pass against the new `alpha-claw`-connected Railway service, should `openclaw-railway-template` be archived (read-only, no delete) or deleted?

### HF-3: `workspace-skills/` vs `lib/setup/skills/` placement

Skills in `openclaw-railway-template/workspace-skills/` (e.g. `market-risk-score`) are container-external. Skills in `lib/setup/skills/` are seeded by alphaclaw on every startup via `syncWorkspaceSkills`. These are behaviourally equivalent — the only difference is that `lib/setup/skills/` skills appear in the npm package and any future consumer of `@chrysb/alphaclaw` would receive them.

**Tag: @iamsteveng** — are these workspace skills specific to your deployment (should stay out of the npm package, e.g. in a new `deploy/workspace-skills/` directory copied by `entrypoint.sh`) or are they general enough to bundle into `lib/setup/skills/`?

### HF-4: V6 Railway deployment polling — CLI version and JSON schema

The `railway deployment list --json` output schema may differ across CLI versions. If V6 fails with a JSON parse error, it means the `status` field name or the array format has changed in the installed `railway` CLI version.

**Observation:** verify the output of `railway deployment list --json | python3 -m json.tool` against the actual schema before wiring V6 into CI. Adjust the `deployments[0]['status']` accessor if the field is nested differently in the installed version.
