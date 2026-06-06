#!/usr/bin/env bash
# Test 13: Policy gate — conflict detection surfaces opposing long/short on same ticker.
# Usage: bash src/scripts/tests/test-policy-conflict.sh

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

cleanup() {
  gbrain delete plans/aapl 2>/dev/null || true
  gbrain delete twitter/post/test-conflict 2>/dev/null || true
  gbrain delete watchlist/current 2>/dev/null || true
  ac_remove_crons 2>/dev/null || true
}
trap cleanup EXIT

ac_login
ac_ensure_crons

echo "=== Test 13: Policy gate — conflict detection ==="

echo "--> Seeding active LONG plan for AAPL..."
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
Existing long plan.
EOF

echo "--> Seeding bearish GBrain content for AAPL (suggests SHORT)..."
gbrain_seed twitter/post/test-conflict <<'EOF'
---
type: tweet
tweet_id: test-conflict
author: "@bearishtrader"
posted_at: 2026-06-04T10:00:00Z
tags: [twitter, x-list-ingest]
---
$AAPL broken below the 200-day MA. Distribution pattern confirmed. This is a SHORT. Entry $150, target $132, invalidation $157. Risk/reward is excellent on the short side. AI spending slowdown will crush margins.
EOF

echo "--> Seeding watchlist with AAPL..."
gbrain_seed watchlist/current <<'EOF'
---
type: watchlist
updated_at: 2026-06-04T11:00:00Z
---

## Active Tickers

- AAPL (conviction: 4, direction: LONG)
EOF

echo "--> Running watchlist-builder cron (waiting 180s for agent to complete)..."
ac_run_cron trading-watchlist-builder
sleep 180

echo ""
echo "--> Asserting..."
PLAN=$(gbrain get plans/aapl 2>/dev/null || echo "")
check "AAPL plan direction remains LONG (no silent override)" "echo '$PLAN' | grep -q 'direction: LONG'"

echo ""
confirm "Telegram shows conflict warning: existing LONG, new evidence suggests SHORT"
confirm "Telegram does NOT show a new SHORT plan created for AAPL"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
