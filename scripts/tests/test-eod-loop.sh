#!/usr/bin/env bash
# Test 11: EOD learning loop — produces gap analysis and writes to learning/<date>.
# Usage: bash src/scripts/tests/test-eod-loop.sh

set -euo pipefail

source "$(dirname "$0")/helpers.sh"

TODAY=$(date +%Y-%m-%d)
PASS=0; FAIL=0

check() {
  local label="$1"; local cmd="$2"
  if eval "$cmd" 2>/dev/null; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label"; FAIL=$((FAIL+1))
  fi
}

confirm() {
  local label="$1"
  read -r -p "  ❓ $label [y/n]: " ans
  if [[ "$ans" == "y" ]]; then
    echo "  ✅ $label (Steve confirmed)"; PASS=$((PASS+1))
  else
    echo "  ❌ $label (Steve said no)"; FAIL=$((FAIL+1))
  fi
}

cleanup() {
  gbrain delete plans/aapl 2>/dev/null || true
  gbrain delete plans/tsla 2>/dev/null || true
  gbrain delete "learning/$TODAY" 2>/dev/null || true
  ac_remove_crons 2>/dev/null || true
}
trap cleanup EXIT

ac_login
ac_ensure_crons

echo "=== Test 11: EOD learning loop ==="

echo "--> Seeding active plan (AAPL LONG, not yet hit target)..."
gbrain_seed plans/aapl <<'EOF'
---
type: trading-plan
ticker: AAPL
direction: LONG
entry: 150
target: 165
invalidation: 144
rr_ratio: 2.5
conviction: 4
status: active
---
Active long plan to evaluate at EOD.
EOF

echo "--> Seeding closed plan (TSLA SHORT, hit target)..."
gbrain_seed plans/tsla <<'EOF'
---
type: trading-plan
ticker: TSLA
direction: SHORT
entry: 200
target: 180
invalidation: 210
rr_ratio: 2.0
conviction: 3
status: closed
---
Closed short — target reached.
EOF

echo "--> Running eod-loop cron (waiting 150s for agent to complete)..."
ac_run_cron trading-eod-loop
sleep 150

echo ""
echo "--> Asserting GBrain state..."
# Write GBrain output to a temp file to avoid single-quote issues in eval.
# GBrain serializes date fields as `date: '2026-06-04T...'` which breaks
# the `eval "... '$VAR' ..."` pattern used by check().
LEARNING_FILE=$(mktemp)
gbrain get "learning/$TODAY" > "$LEARNING_FILE" 2>/dev/null || true
check "learning/$TODAY page created"             "[[ -s \"$LEARNING_FILE\" ]]"
check "learning page contains gap analysis"      "grep -qi 'gap\|analysis\|plan\|actual' \"$LEARNING_FILE\""
check "learning page mentions AAPL or TSLA"      "grep -qE 'AAPL|TSLA' \"$LEARNING_FILE\""
rm -f "$LEARNING_FILE"

echo ""
confirm "Telegram shows EOD summary with gap analysis"
confirm "Telegram includes improvement proposals (conviction, RR, or market risk overlay)"
confirm "Telegram states proposals require Steve confirmation (not auto-applied)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
