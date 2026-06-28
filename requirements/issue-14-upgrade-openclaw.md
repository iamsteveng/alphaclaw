# Feature: Upgrade OpenClaw Version — Requirements

Issue: [#14](https://github.com/iamsteveng/alpha-claw/issues/14)

## Goals

- The `openclaw` npm package used by AlphaClaw is upgraded from `2026.5.6` to `2026.6.10` (the current `latest` dist-tag on npm).
- The Docker image builds successfully with the new version.
- On Railway, after deploying from the branch, the OpenClaw gateway starts and the agent responds to messages.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

### 1. Version pin in source

```bash
# package.json declares the exact new version
node -e "const p=require('./package.json'); if(p.dependencies.openclaw!=='2026.6.10'){process.exit(1)}" \
  && echo "PASS: package.json version correct" \
  || { echo "FAIL: package.json version wrong"; exit 1; }
```

### 2. Lock file resolves to new version

```bash
# package-lock.json resolves openclaw to 2026.6.10 (not the old version)
node -e "
  const l=require('./package-lock.json');
  const v=(l.packages&&l.packages['node_modules/openclaw']&&l.packages['node_modules/openclaw'].version)||'';
  if(v!=='2026.6.10'){console.error('FAIL: lock resolves to',v||'(not found)');process.exit(1);}
  console.log('PASS: lock resolves to',v);
"
```

### 3. Docker image builds without error

```bash
# Build exits 0 — npm ci must complete, no openclaw install errors
docker build --no-cache -t alphaclaw-test:issue-14 . 2>&1 | tee /tmp/build.log
grep -iE 'error|failed|ERR!' /tmp/build.log | grep -v 'npm warn' && { echo "FAIL: build had errors"; exit 1; } || echo "PASS: build clean"
```

### 4. Node.js engine requirement satisfied inside container

`openclaw@2026.6.10` requires `node >=22.19.0`. The `node:22-slim` base image must provide a version that satisfies this.

```bash
# Run inside the built image
docker run --rm alphaclaw-test:issue-14 node -e "
  const [major,minor]='$( node --version )'.replace('v','').split('.').map(Number);
  // evaluated at runtime inside container
" node -e "
  const v=process.version.replace('v','').split('.').map(Number);
  if(v[0]<22||v[1]<19){console.error('FAIL: node',process.version,'< 22.19.0');process.exit(1);}
  console.log('PASS: node',process.version,'>= 22.19.0');
"
```

### 5. openclaw binary version inside container

```bash
docker run --rm alphaclaw-test:issue-14 openclaw --version 2>&1 | grep -E '^2026\.6\.10$' \
  && echo "PASS: openclaw --version correct" \
  || { echo "FAIL: unexpected openclaw version"; exit 1; }
```

### 6. Gateway starts on Railway (post-deploy)

After pushing the branch and Railway deploys the new image, confirm the gateway comes up:

```bash
RAILWAY_URL="https://openclaw-railway-template-production-a7f6.up.railway.app"

# Authenticate
curl -s -c /tmp/ac14.txt -X POST "$RAILWAY_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$SETUP_PASSWORD\"}" | python3 -c "
import json,sys; r=json.load(sys.stdin)
if not r.get('ok'): print('FAIL: login failed',r); exit(1)
print('PASS: logged in')
"

# Gateway status must be 'running'
curl -s -b /tmp/ac14.txt "$RAILWAY_URL/api/gateway/status" | python3 -c "
import json,sys; r=json.load(sys.stdin)
s=r.get('status','')
if s!='running': print('FAIL: gateway status =',s); exit(1)
print('PASS: gateway status = running')
"
```

### 7. Agent responds to a test message on Railway

```bash
# Send a minimal message to the main agent and verify a non-empty reply
RESP=$(curl -s -b /tmp/ac14.txt -X POST "$RAILWAY_URL/api/agent/message" \
  -H "Content-Type: application/json" \
  -d '{"message":"ping — reply with the single word PONG","sessionKey":"agent:main:main"}')

echo "$RESP" | python3 -c "
import json,sys
r=json.load(sys.stdin)
if not r.get('ok'): print('FAIL: agent call failed:', r); exit(1)
reply=r.get('reply','') or r.get('content','') or r.get('message','')
if not reply.strip(): print('FAIL: empty reply'); exit(1)
print('PASS: agent replied:', reply[:120])
"
```

## Constraints

- Do not change the Dockerfile structure (layer order, tool installations, gbrain setup).
- Do not upgrade `@anthropic-ai/claude-code` — only `openclaw` is in scope.
- Do not modify gateway spawning logic in `lib/server/gateway.js`.
- Do not modify `entrypoint.sh` unless required to accommodate a breaking change in `openclaw@2026.6.10`.
- `package.json` must pin the exact version (`"openclaw": "2026.6.10"`), not a range.

## When You Need Human Feedback

- **Node.js base image version:** `openclaw@2026.6.10` requires `node >=22.19.0`. If `node:22-slim` at build time resolves to a version below 22.19.0, the Dockerfile's base image tag must be pinned to a specific patch version (e.g. `node:22.19.0-slim`). The correct pinned tag cannot be determined without running the build — if verification step 4 fails, tag @iamsteveng with the actual node version found and a suggested pin.

- **Breaking changes in 2026.6.10:** The changelog between `2026.5.6` and `2026.6.10` has not been reviewed. If `entrypoint.sh` or `lib/server/gateway.js` requires changes to accommodate the new version (e.g. new required config fields, removed CLI flags), list the specific changes needed in a PR comment and tag @iamsteveng before implementing.

- **Railway deploy method:** The issue says "deploy directly from branch to Railway." If this requires a manual Railway CLI command or a specific branch naming convention beyond a normal push, tag @iamsteveng with the steps needed.
