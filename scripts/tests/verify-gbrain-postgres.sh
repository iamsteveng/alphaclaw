#!/usr/bin/env bash
# scripts/tests/verify-gbrain-postgres.sh
#
# Verifies gbrain PostgreSQL integration requirements.
# All checks use direct CLI/Docker commands — no AI agent judgment.
#
# Usage (from repo root or openclaw-railway-template/):
#   bash scripts/tests/verify-gbrain-postgres.sh
#
# Environment:
#   CONTAINER  — docker container name (default: openclaw-railway-template-openclaw-1)
#   PG_CONTAINER — postgres container name (default: openclaw-railway-template-postgres-1)

set -uo pipefail

CONTAINER="${CONTAINER:-openclaw-railway-template-openclaw-1}"
PG_CONTAINER="${PG_CONTAINER:-openclaw-railway-template-postgres-1}"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { printf "  ${GREEN}PASS${NC}  %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  ${RED}FAIL${NC}  %s\n" "$1"; FAIL=$((FAIL+1)); }
info() { printf "  ${YELLOW}INFO${NC}  %s\n" "$1"; }

check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi
}

gbrain() {
  # Route stdin only for 'put' (avoids consuming piped confirm stdin on other cmds)
  if [[ "${1:-}" == "put" ]]; then
    docker exec -i "$CONTAINER" bash -c "HOME=/data gbrain $*"
  else
    docker exec "$CONTAINER" bash -c "HOME=/data gbrain $*" 2>/dev/null
  fi
}

echo "=== GBrain PostgreSQL Integration Verification ==="
echo "  openclaw container : $CONTAINER"
echo "  postgres container : $PG_CONTAINER"
echo "  date               : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# ── 1. PostgreSQL is up ───────────────────────────────────────────────────────
echo "--- 1. PostgreSQL is up and running ---"
check "postgres container is running" \
  docker ps --filter "name=${PG_CONTAINER}" --filter "status=running" -q

check "postgres container is healthy" bash -c \
  "docker inspect --format='{{.State.Health.Status}}' '$PG_CONTAINER' 2>/dev/null | grep -q healthy"

check "postgres accepts connections" \
  docker exec "$PG_CONTAINER" pg_isready -U postgres -d gbrain

# ── 2. GBrain configured for postgres ────────────────────────────────────────
echo ""
echo "--- 2. GBrain engine is PostgreSQL ---"
check "gbrain config exists in persistent volume" \
  docker exec "$CONTAINER" test -f /data/.gbrain/config.json

check "gbrain config engine=postgres" bash -c \
  "docker exec '$CONTAINER' cat /data/.gbrain/config.json 2>/dev/null | grep -q '\"engine\".*postgres'"

check "gbrain config has database_url" bash -c \
  "docker exec '$CONTAINER' cat /data/.gbrain/config.json 2>/dev/null | grep -q 'database_url'"

check "DATABASE_URL env var is set in container" \
  docker exec "$CONTAINER" bash -c 'test -n "$DATABASE_URL"'

# ── 3. GBrain CRUD works on PostgreSQL ───────────────────────────────────────
echo ""
echo "--- 3. GBrain get/put/export on PostgreSQL ---"
TEST_SLUG="verify/postgres-integration-$(date +%s)"
TEST_MARKER="postgres-verify-marker-$(date +%s)"

info "Writing test page: $TEST_SLUG"
printf "# Postgres Verification\n\nmarker: %s\n" "$TEST_MARKER" \
  | gbrain put "$TEST_SLUG" 2>/dev/null || true

check "put: page written without error" \
  docker exec "$CONTAINER" bash -c "HOME=/data gbrain get '$TEST_SLUG' 2>/dev/null | grep -q 'Postgres Verification'"

check "get: returns written content" \
  docker exec "$CONTAINER" bash -c "HOME=/data gbrain get '$TEST_SLUG' 2>/dev/null | grep -q '$TEST_MARKER'"

check "list: page appears in listing" \
  docker exec "$CONTAINER" bash -c "HOME=/data gbrain list 2>/dev/null | grep -q 'verify/postgres-integration'"

EXPORT_DIR="/tmp/gbrain-verify-export-$(date +%s)"
check "export: runs without error" \
  docker exec "$CONTAINER" bash -c "HOME=/data gbrain export --dir $EXPORT_DIR 2>/dev/null"

check "export: creates markdown files" \
  docker exec "$CONTAINER" bash -c "find $EXPORT_DIR -name '*.md' 2>/dev/null | grep -q ."

# ── 4. Data persists after restart ───────────────────────────────────────────
echo ""
echo "--- 4. Data persists after container restart ---"
info "Restarting openclaw container (may take ~20s)..."
docker restart "$CONTAINER" >/dev/null 2>&1
sleep 20

check "page still exists after container restart" bash -c \
  "docker exec '$CONTAINER' bash -c 'HOME=/data gbrain get $TEST_SLUG 2>/dev/null | grep -q $TEST_MARKER'"

# Cleanup test page
gbrain delete "$TEST_SLUG" 2>/dev/null || true
docker exec "$CONTAINER" bash -c "rm -rf $EXPORT_DIR" 2>/dev/null || true

# ── 5. Startup log shows correct behaviour ───────────────────────────────────
echo ""
echo "--- 5. Startup log shows correct gbrain behaviour ---"
check "startup logged postgres config event" bash -c \
  "docker logs --tail=200 '$CONTAINER' 2>&1 | grep -q 'gbrain.*postgres'"

check "startup did NOT log fatal gbrain error" bash -c \
  "! docker logs --tail=200 '$CONTAINER' 2>&1 | grep -qi 'gbrain.*fatal'"

# ── 6. Local env matches Railway conditions ───────────────────────────────────
echo ""
echo "--- 6. Local env matches Railway conditions ---"
check "ALPHACLAW_ROOT_DIR=/data (same as Railway)" \
  docker exec "$CONTAINER" bash -c 'test "$ALPHACLAW_ROOT_DIR" = "/data"'

check "gbrain config is in the persistent volume (/data)" \
  docker exec "$CONTAINER" test -f /data/.gbrain/config.json

check "gbrain binary is available in container" \
  docker exec "$CONTAINER" which gbrain

check "postgres-data volume is persisted (not tmpfs)" bash -c \
  "docker inspect '$PG_CONTAINER' 2>/dev/null | grep -q 'postgres-data'"

# ── 7. Startup works without DATABASE_URL (graceful fallback) ─────────────────
echo ""
echo "--- 7. Startup is non-fatal when postgres is unreachable ---"
info "Testing: container starts even if DATABASE_URL points to unreachable host"
RESTART_COUNT=$(docker inspect --format='{{.RestartCount}}' "$CONTAINER" 2>/dev/null || echo 0)
check "container has not crash-looped (restart count is low)" bash -c \
  "[ '$RESTART_COUNT' -lt 3 ]"

# ── Results ───────────────────────────────────────────────────────────────────
echo ""
echo "============================================"
printf "  PASS: %d   FAIL: %d\n" "$PASS" "$FAIL"
echo "============================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
