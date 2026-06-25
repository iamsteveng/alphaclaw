#!/usr/bin/env bash
# scripts/tests/test-gbrain-agent-list.sh
#
# Sends a message to the openclaw agent asking it to list gbrain pages,
# then verifies the agent's response contains the seeded slugs and that
# those slugs also exist as rows in postgres.
#
# Prerequisites: docker compose must be running with SETUP_PASSWORD set.
#   npm run dev   (or: SETUP_PASSWORD=<pw> docker compose up -d --build)
#
# Usage:
#   SETUP_PASSWORD=<pw> bash scripts/tests/test-gbrain-agent-list.sh

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
  if eval "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi
}

gbrain() {
  if [[ "${1:-}" == "put" ]]; then
    docker exec -i "$CONTAINER" bash -c "HOME=/data gbrain $*"
  else
    docker exec "$CONTAINER" bash -c "HOME=/data gbrain $*" 2>/dev/null
  fi
}

cleanup() {
  gbrain delete "$SLUG_A" 2>/dev/null || true
  gbrain delete "$SLUG_B" 2>/dev/null || true
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
check "AlphaClaw health endpoint is up" \
  bash -c "curl -sf 'http://localhost:$PORT/health' >/dev/null"

# ── 2. Seed test pages ─────────────────────────────────────────────────────────
echo ""
echo "--- 2. Seed test pages into gbrain (postgres) ---"
TS=$(date +%s)
SLUG_A="test/agent-list-alpha-$TS"
SLUG_B="test/agent-list-beta-$TS"
MARKER_A="marker-alpha-$TS"
MARKER_B="marker-beta-$TS"

trap cleanup EXIT

info "Seeding $SLUG_A"
printf "# Alpha Test Page\nmarker: %s\n" "$MARKER_A" | gbrain put "$SLUG_A" 2>/dev/null || true
info "Seeding $SLUG_B"
printf "# Beta Test Page\nmarker: %s\n" "$MARKER_B" | gbrain put "$SLUG_B" 2>/dev/null || true

check "seed: page A content is readable via gbrain get" \
  bash -c "docker exec '$CONTAINER' bash -c \"HOME=/data gbrain get '$SLUG_A' 2>/dev/null | grep -q '$MARKER_A'\""
check "seed: page B content is readable via gbrain get" \
  bash -c "docker exec '$CONTAINER' bash -c \"HOME=/data gbrain get '$SLUG_B' 2>/dev/null | grep -q '$MARKER_B'\""

# ── 3. Verify seeded pages in postgres ────────────────────────────────────────
echo ""
echo "--- 3. Verify seeded pages exist in postgres ---"
check "postgres: page A row is present and not deleted" \
  bash -c "docker exec '$PG_CONTAINER' psql -U postgres -d gbrain -t \
    -c \"SELECT 1 FROM pages WHERE slug='$SLUG_A' AND deleted_at IS NULL\" 2>/dev/null \
    | grep -qE '[[:space:]]*1[[:space:]]*'"
check "postgres: page B row is present and not deleted" \
  bash -c "docker exec '$PG_CONTAINER' psql -U postgres -d gbrain -t \
    -c \"SELECT 1 FROM pages WHERE slug='$SLUG_B' AND deleted_at IS NULL\" 2>/dev/null \
    | grep -qE '[[:space:]]*1[[:space:]]*'"

# ── 4. Send list message to agent ─────────────────────────────────────────────
echo ""
echo "--- 4. Send gbrain list message to agent ---"
info "Logging in to AlphaClaw..."
curl -s -c "$COOKIES" -X POST "http://localhost:$PORT/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" >/dev/null

MESSAGE="Run this shell command and output the result verbatim with no extra commentary: gbrain list"
MSG_JSON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$MESSAGE")
info "Sending message to agent (may take 30-60s)..."
RESPONSE=$(curl -s --max-time 120 -b "$COOKIES" \
  -X POST "http://localhost:$PORT/api/agent/message" \
  -H "Content-Type: application/json" \
  -d "{\"message\":$MSG_JSON}" 2>/dev/null || echo '{"ok":false,"stdout":""}')

API_OK=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(str(d.get('ok',False)).lower())" 2>/dev/null || echo "false")
STDOUT=$(echo "$RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout',''))" 2>/dev/null || echo "")

check "agent message API returned ok=true" "[[ '$API_OK' == 'true' ]]"
check "agent response includes page A slug ($SLUG_A)" "[[ '$STDOUT' == *'$SLUG_A'* ]]"
check "agent response includes page B slug ($SLUG_B)" "[[ '$STDOUT' == *'$SLUG_B'* ]]"

# ── 5. Cross-check: postgres has what agent listed ────────────────────────────
echo ""
echo "--- 5. Cross-check: postgres rows match agent-reported slugs ---"
PG_LIST=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -t \
  -c "SELECT slug FROM pages WHERE slug LIKE 'test/agent-list-%' AND deleted_at IS NULL ORDER BY slug" \
  2>/dev/null | sed 's/^[[:space:]]*//' | grep -v '^$' || echo "")

check "postgres: page A slug appears in postgres query results" \
  "[[ '$PG_LIST' == *'$SLUG_A'* ]]"
check "postgres: page B slug appears in postgres query results" \
  "[[ '$PG_LIST' == *'$SLUG_B'* ]]"

# Confirm each slug agent reported also exists in postgres
if [[ -n "$STDOUT" ]] && [[ -n "$PG_LIST" ]]; then
  MISMATCHES=0
  while IFS= read -r line; do
    slug=$(echo "$line" | grep -oE 'test/agent-list-[a-z]+-[0-9]+' || true)
    [[ -z "$slug" ]] && continue
    if echo "$PG_LIST" | grep -qF "$slug"; then
      pass "agent-listed slug '$slug' confirmed in postgres"
    else
      fail "agent-listed slug '$slug' NOT found in postgres"
      MISMATCHES=$((MISMATCHES+1))
    fi
  done <<< "$STDOUT"
fi

# ── Results ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
printf "  PASS: %d   FAIL: %d\n" "$PASS" "$FAIL"
echo "============================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
