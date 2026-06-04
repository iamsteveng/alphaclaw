#!/usr/bin/env bash
# Test 7: All 3 trading crons registered with correct schedules.
# Calls alphaclaw API directly — run from host.
# Usage: bash src/scripts/tests/test-setup-crons.sh

set -euo pipefail

PORT="${PORT:-3001}"
PASSWORD="${SETUP_PASSWORD:-62875094}"
COOKIES="/tmp/ac-test-cookies.txt"
PASS=0; FAIL=0

check() {
  local label="$1"; local cmd="$2"
  if eval "$cmd" &>/dev/null; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label"; FAIL=$((FAIL+1))
  fi
}

cleanup() {
  curl -s -b "$COOKIES" -X DELETE "http://localhost:$PORT/api/trading-crons" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== Test 7: Cron setup ==="

curl -s -c "$COOKIES" -X POST "http://localhost:$PORT/api/auth/login" \
  -H "Content-Type: application/json" -d "{\"password\":\"$PASSWORD\"}" > /dev/null

SESSIONS=$(curl -s -b "$COOKIES" "http://localhost:$PORT/api/agent/sessions")
TELEGRAM_TO=$(echo "$SESSIONS" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for s in data.get('sessions',[]):
    if s.get('channel')=='telegram' and s.get('replyTo'):
        print(s['replyTo']); break
" 2>/dev/null || true)

[[ -z "$TELEGRAM_TO" ]] && { echo "Error: No Telegram session found"; exit 1; }
echo "--> Telegram delivery: $TELEGRAM_TO"

echo "--> Registering crons..."
ENSURE=$(curl -s -b "$COOKIES" -X POST "http://localhost:$PORT/api/trading-crons/ensure" \
  -H "Content-Type: application/json" \
  -d "{\"deliveryChannel\":\"telegram\",\"deliveryTo\":\"$TELEGRAM_TO\"}")
ENSURE_OK=$(echo "$ENSURE" | python3 -c "import json,sys; print('yes' if json.load(sys.stdin).get('ok') else 'no')" 2>/dev/null || echo "no")

check "ensure returned ok" "[[ '$ENSURE_OK' == 'yes' ]]"

STATUS=$(curl -s -b "$COOKIES" "http://localhost:$PORT/api/trading-crons/status")
WB=$(echo "$STATUS"  | python3 -c "import json,sys; jobs={j['name']:j['job'] for j in json.load(sys.stdin)['jobs']}; j=jobs.get('trading-watchlist-builder'); print(j['schedule']['expr'] if j else '')" 2>/dev/null)
PR=$(echo "$STATUS"  | python3 -c "import json,sys; jobs={j['name']:j['job'] for j in json.load(sys.stdin)['jobs']}; j=jobs.get('trading-price-report'); print(j['schedule']['expr'] if j else '')" 2>/dev/null)
EOD=$(echo "$STATUS" | python3 -c "import json,sys; jobs={j['name']:j['job'] for j in json.load(sys.stdin)['jobs']}; j=jobs.get('trading-eod-loop'); print(j['schedule']['expr'] if j else '')" 2>/dev/null)

check "trading-watchlist-builder registered" "[[ -n '$WB' ]]"
check "trading-price-report registered"      "[[ -n '$PR' ]]"
check "trading-eod-loop registered"          "[[ -n '$EOD' ]]"
check "watchlist-builder has cron schedule"  "[[ '$WB' == '30 11 * * 1-5' ]]"
check "price-report has cron schedule"       "[[ '$PR' == '*/15 13-15 * * 1-5' ]]"
check "eod-loop has cron schedule"           "[[ '$EOD' == '10 8 * * 1-5' ]]"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
