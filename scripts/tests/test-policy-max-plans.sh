#!/usr/bin/env bash
# Test 12: Policy gate — max 10 active plans blocks new plan.
# Usage: bash src/scripts/tests/test-policy-max-plans.sh

set -euo pipefail

source "$(dirname "$0")/helpers.sh"

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

TICKERS=(t01 t02 t03 t04 t05 t06 t07 t08 t09 t10)

cleanup() {
  for t in "${TICKERS[@]}"; do
    gbrain delete "plans/$t" 2>/dev/null || true
  done
  gbrain delete plans/t11 2>/dev/null || true
  gbrain delete twitter/post/test-cap 2>/dev/null || true
  gbrain delete watchlist/current 2>/dev/null || true
  ac_remove_crons 2>/dev/null || true
}
trap cleanup EXIT

ac_login
ac_ensure_crons

echo "=== Test 12: Policy gate — max 10 active plans ==="

echo "--> Seeding 10 active plans..."
for t in "${TICKERS[@]}"; do
  gbrain_seed "plans/$t" <<EOF
---
type: trading-plan
ticker: $t
direction: LONG
entry: 100
target: 120
invalidation: 90
rr_ratio: 2.0
conviction: 3
status: active
---
Test plan $t.
EOF
done

echo "--> Seeding GBrain content for T11..."
gbrain_seed twitter/post/test-cap <<'EOF'
---
type: tweet
tweet_id: test-cap
author: "@tradersignals"
posted_at: 2026-06-04T10:00:00Z
tags: [twitter, x-list-ingest]
---
$T11 setting up for a breakout. Strong support at $50. Target $65. This is the trade of the week with tight invalidation at $47.
EOF

echo "--> Seeding watchlist with 10 tickers..."
WATCHLIST_BODY="## Active Tickers"$'\n'
for t in "${TICKERS[@]}"; do
  WATCHLIST_BODY+="- $t (conviction: 3, direction: LONG)"$'\n'
done
printf -- "---\ntype: watchlist\nupdated_at: 2026-06-04T11:00:00Z\n---\n\n%s" "$WATCHLIST_BODY" | gbrain_seed watchlist/current

echo "--> Running watchlist-builder cron (waiting 180s for agent to complete)..."
ac_run_cron trading-watchlist-builder
sleep 180

echo ""
echo "--> Asserting..."
T11_PAGE=$(gbrain get plans/t11 2>/dev/null || echo "")
check "plans/t11 does NOT exist (blocked by cap)" "[[ -z '$T11_PAGE' ]]"

echo ""
confirm "Telegram mentions plan cap (10) — T11 blocked"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
