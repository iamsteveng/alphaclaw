#!/usr/bin/env bash
# Test 10: Watchlist builder — existing ticker conviction audit.
# Seeds an active AAPL LONG with conviction 4, then feeds bearish content.
# Expects the agent to propose a conviction downgrade in Telegram (not auto-apply).
# Usage: bash src/scripts/tests/test-watchlist-audit.sh

set -euo pipefail

source "$(dirname "$0")/helpers.sh"

OPENCLAW_DIR="${OPENCLAW_DIR:-/data/.openclaw}"
PRICES_FILE="$OPENCLAW_DIR/finnhub-prices.json"
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
  gbrain delete twitter/post/test-audit 2>/dev/null || true
  gbrain delete watchlist/current 2>/dev/null || true
  gbrain delete watchlist/last-run 2>/dev/null || true
  docker exec openclaw-railway-template-openclaw-1 rm -f "$PRICES_FILE" 2>/dev/null || true
  ac_remove_crons 2>/dev/null || true
}
trap cleanup EXIT

ac_login
ac_ensure_crons

echo "=== Test 10: Watchlist builder — conviction audit ==="

echo "--> Seeding active AAPL LONG plan (conviction 4, entry 150)..."
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
market_risk_at_creation: Risk On
status: active
created_at: 2026-06-01T11:30:00Z
updated_at: 2026-06-01T11:30:00Z
---

## Evidence

1. Breaking out above 200-day MA with volume.
2. Strong support at $144 (prior swing low).
3. AI revenue acceleration — services margin expansion.
EOF

echo "--> Seeding bearish GBrain content for AAPL (support broken)..."
gbrain_seed twitter/post/test-audit <<'EOF'
---
type: tweet
tweet_id: test-audit
author: "@technicalanalyst"
posted_at: 2026-06-04T09:00:00Z
tags: [twitter, x-list-ingest]
---
$AAPL closed below the $144 support on heavy volume today. The 200-day MA has now flipped to resistance. Services growth missing estimates two quarters in a row. The long thesis from last week is now invalidated. Anyone still holding should reconsider conviction here.
EOF

echo "--> Seeding watchlist with AAPL..."
gbrain_seed watchlist/current <<'EOF'
---
type: watchlist
updated_at: 2026-06-01T11:30:00Z
---

## Active Tickers

- AAPL (conviction: 4, direction: LONG)
EOF

echo "--> Writing prices (AAPL below invalidation level 144)..."
echo '{"AAPL": { "open": 143, "current": 141, "changePct": -1.40, "updatedAt": "2026-06-04T11:30:00.000Z" }}' | \
  docker exec -i openclaw-railway-template-openclaw-1 bash -c "mkdir -p $OPENCLAW_DIR && cat > $PRICES_FILE"

echo "--> Running watchlist-builder cron (waiting 180s for agent to complete)..."
ac_run_cron trading-watchlist-builder
sleep 180

echo ""
echo "--> Asserting GBrain state..."
PLAN=$(gbrain get plans/aapl 2>/dev/null || echo "")
check "plans/aapl still exists"          "[[ -n '$PLAN' ]]"
check "plans/aapl direction still LONG (no silent override)" "echo '$PLAN' | grep -q 'direction: LONG'"

echo ""
confirm "Telegram shows conviction update proposal for AAPL (conviction lowered from 4)"
confirm "Telegram mentions reason: support broken at \$144 or new bearish evidence"
confirm "Telegram does NOT say conviction was auto-updated — requires Steve confirmation"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
