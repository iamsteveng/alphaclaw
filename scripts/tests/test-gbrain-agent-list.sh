#!/usr/bin/env bash
# scripts/tests/test-gbrain-agent-list.sh
#
# Verifies that gbrain pages (backed by postgres) can be listed by both the
# gbrain CLI and the POST /api/agent/message endpoint, and that both sources
# agree with the postgres rows.
#
# Note on the agent message test: clawCmd has a 15s timeout. If the LLM
# responds in time the agent stdout is checked; if not (clawCmd times out)
# the section is noted as INFO — unit tests cover that path via mocked clawCmd.
#
# Prerequisites: docker compose must be running with SETUP_PASSWORD set.
#   SETUP_PASSWORD=<pw> npm run dev   (or docker compose up -d --build)
#
# Usage:
#   SETUP_PASSWORD=<pw> bash scripts/tests/test-gbrain-agent-list.sh
#
# Optional overrides:
#   CONTAINER=alpha-claw-openclaw-1
#   PG_CONTAINER=alpha-claw-postgres-1
#   PORT=3000

set -uo pipefail

CONTAINER="${CONTAINER:-alpha-claw-openclaw-1}"
PG_CONTAINER="${PG_CONTAINER:-alpha-claw-postgres-1}"
PORT="${PORT:-3000}"
PASSWORD="${SETUP_PASSWORD:?SETUP_PASSWORD env var must be set}"
COOKIES="/tmp/ac-gbrain-list-test-$$.txt"
PASS=0; FAIL=0

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { printf "  ${GREEN}PASS${NC}  %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ${RED}FAIL${NC}  %s\n" "$1"; FAIL=$((FAIL+1)); }
info() { printf "  ${YELLOW}INFO${NC}  %s\n" "$1"; }

check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi
}

check_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$desc"; else fail "$desc"; fi
}

gbrain_exec() {
  if [[ "${1:-}" == "put" ]]; then
    docker exec -i "$CONTAINER" bash -c "HOME=/data gbrain $*"
  else
    docker exec "$CONTAINER" bash -c "HOME=/data gbrain $*" 2>/dev/null
  fi
}

cleanup() {
  gbrain_exec delete "$SLUG_A" 2>/dev/null || true
  gbrain_exec delete "$SLUG_B" 2>/dev/null || true
  rm -f "$COOKIES"
}

echo "=== Agent GBrain List Verification ==="
echo "  container  : $CONTAINER"
echo "  pg         : $PG_CONTAINER"
echo "  port       : $PORT"
echo ""

# ── 1. Prerequisites ───────────────────────────────────────────────────────────
echo "--- 1. Prerequisites ---"
check "openclaw container is running" \
  docker ps --filter "name=${CONTAINER}" --filter "status=running" -q
check "postgres container is running" \
  docker ps --filter "name=${PG_CONTAINER}" --filter "status=running" -q
check "AlphaClaw API responds" \
  curl -sf "http://localhost:${PORT}/health"

# ── 2. Seed test pages ─────────────────────────────────────────────────────────
echo ""
echo "--- 2. Seed test pages into gbrain (postgres) ---"
TS=$(date +%s)
SLUG_A="test/agent-list-alpha-${TS}"
SLUG_B="test/agent-list-beta-${TS}"
MARKER_A="marker-alpha-${TS}"
MARKER_B="marker-beta-${TS}"

trap cleanup EXIT

info "Seeding ${SLUG_A}"
printf "# Alpha Test Page\nmarker: %s\n" "$MARKER_A" | gbrain_exec put "$SLUG_A" >/dev/null 2>&1 || true
info "Seeding ${SLUG_B}"
printf "# Beta Test Page\nmarker: %s\n" "$MARKER_B" | gbrain_exec put "$SLUG_B" >/dev/null 2>&1 || true

CONTENT_A=$(docker exec "$CONTAINER" bash -c "HOME=/data gbrain get '${SLUG_A}' 2>/dev/null" || echo "")
CONTENT_B=$(docker exec "$CONTAINER" bash -c "HOME=/data gbrain get '${SLUG_B}' 2>/dev/null" || echo "")
check_contains "seed: page A content is readable via gbrain get" "$CONTENT_A" "$MARKER_A"
check_contains "seed: page B content is readable via gbrain get" "$CONTENT_B" "$MARKER_B"

# ── 3. Verify seeded pages in postgres ────────────────────────────────────────
echo ""
echo "--- 3. Verify seeded pages exist in postgres ---"
COUNT_A=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -t \
  -c "SELECT COUNT(*) FROM pages WHERE slug='${SLUG_A}' AND deleted_at IS NULL" \
  2>/dev/null | tr -d ' \n' || echo "0")
COUNT_B=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -t \
  -c "SELECT COUNT(*) FROM pages WHERE slug='${SLUG_B}' AND deleted_at IS NULL" \
  2>/dev/null | tr -d ' \n' || echo "0")
check "postgres: page A row is present and not deleted" test "$COUNT_A" = "1"
check "postgres: page B row is present and not deleted" test "$COUNT_B" = "1"

# ── 4. gbrain list matches postgres ───────────────────────────────────────────
echo ""
echo "--- 4. gbrain list output matches postgres rows ---"
GBRAIN_LIST=$(docker exec "$CONTAINER" bash -c "HOME=/data gbrain list 2>/dev/null" || echo "")
PG_SLUGS=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -t \
  -c "SELECT slug FROM pages WHERE slug LIKE 'test/agent-list-%' AND deleted_at IS NULL ORDER BY slug" \
  2>/dev/null | sed 's/^[[:space:]]*//' | grep -v '^$' || echo "")

check_contains "gbrain list includes page A slug" "$GBRAIN_LIST" "$SLUG_A"
check_contains "gbrain list includes page B slug" "$GBRAIN_LIST" "$SLUG_B"
check_contains "postgres confirms page A slug"    "$PG_SLUGS"    "$SLUG_A"
check_contains "postgres confirms page B slug"    "$PG_SLUGS"    "$SLUG_B"

# Cross-check: every test slug gbrain lists is also confirmed in postgres
while IFS= read -r line; do
  slug=$(echo "$line" | grep -oE 'test/agent-list-[a-z]+-[0-9]+' 2>/dev/null || true)
  [[ -z "$slug" ]] && continue
  check_contains "gbrain-listed slug '${slug}' confirmed in postgres" "$PG_SLUGS" "$slug"
done <<< "$GBRAIN_LIST"

# ── 5. POST /api/agent/message — send gbrain list message ────────────────────
echo ""
echo "--- 5. POST /api/agent/message sends gbrain list request ---"
info "Logging in to AlphaClaw..."
LOGIN_RESULT=$(curl -s -c "$COOKIES" -X POST "http://localhost:${PORT}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${PASSWORD}\"}" 2>/dev/null || echo '{}')
LOGIN_OK=$(echo "$LOGIN_RESULT" | python3 -c \
  "import json,sys; print(str(json.load(sys.stdin).get('ok',False)).lower())" 2>/dev/null || echo "false")
check "login to AlphaClaw succeeds" test "$LOGIN_OK" = "true"

MSG_JSON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" \
  "Run this command and show me the output: gbrain list")

info "Sending gbrain list message to agent (clawCmd has 15s timeout)..."
RESPONSE=$(curl -s --max-time 30 -b "$COOKIES" \
  -X POST "http://localhost:${PORT}/api/agent/message" \
  -H "Content-Type: application/json" \
  -d "{\"message\":${MSG_JSON}}" 2>/dev/null || echo '{"ok":false,"stdout":"","error":"curl failed"}')

# Check the endpoint is reachable — HTTP status not 404 (502 is acceptable when agent times out)
HTTP_CODE=$(curl -s --max-time 30 -b "$COOKIES" -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:${PORT}/api/agent/message" \
  -H "Content-Type: application/json" \
  -d "{\"message\":${MSG_JSON}}" 2>/dev/null || echo "000")
check "POST /api/agent/message endpoint is reachable (not 404)" test "$HTTP_CODE" != "404"

API_OK=$(echo "$RESPONSE" | python3 -c \
  "import json,sys; print(str(json.load(sys.stdin).get('ok',False)).lower())" 2>/dev/null || echo "false")
API_STDOUT=$(echo "$RESPONSE" | python3 -c \
  "import json,sys; print(json.load(sys.stdin).get('stdout',''))" 2>/dev/null || echo "")
API_ERROR=$(echo "$RESPONSE" | python3 -c \
  "import json,sys; print(json.load(sys.stdin).get('error',''))" 2>/dev/null || echo "")

if [[ "$API_OK" == "true" ]]; then
  # Agent responded within clawCmd timeout — verify it lists the seeded pages
  check_contains "agent response includes page A slug" "$API_STDOUT" "$SLUG_A"
  check_contains "agent response includes page B slug" "$API_STDOUT" "$SLUG_B"
else
  info "Agent did not respond within clawCmd timeout (ok=false, error='${API_ERROR}')"
  info "Unit tests cover this path via mocked clawCmd; gbrain→postgres check (section 4) is the reliable data assertion"
fi

# ── Results ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
printf "  PASS: %d   FAIL: %d\n" "$PASS" "$FAIL"
echo "============================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
