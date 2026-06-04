#!/usr/bin/env bash
# Test 9: Watchlist builder — new ticker generates a pending plan.
# Usage: bash src/scripts/tests/test-watchlist-new-ticker.sh

set -euo pipefail

source "$(dirname "$0")/helpers.sh"

OPENCLAW_DIR="${OPENCLAW_DIR:-/data/.openclaw}"
PRICES_FILE="$OPENCLAW_DIR/finnhub-prices.json"
WATCHLIST_FILE="$OPENCLAW_DIR/finnhub-watchlist.json"
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
  gbrain delete twitter/post/test-001 2>/dev/null || true
  gbrain delete plans/nvda 2>/dev/null || true
  gbrain delete watchlist/current 2>/dev/null || true
  docker exec openclaw-railway-template-openclaw-1 rm -f "$PRICES_FILE" "$WATCHLIST_FILE" 2>/dev/null || true
  ac_remove_crons 2>/dev/null || true
}
trap cleanup EXIT

ac_login
ac_ensure_crons

echo "=== Test 9: Watchlist builder — new ticker ==="

echo "--> Seeding GBrain content (bullish NVDA signal)..."
gbrain_seed twitter/post/test-001 <<'EOF'
---
type: tweet
tweet_id: test-001
author: "@semiconductorpro"
posted_at: 2026-06-04T10:00:00Z
tags: [twitter, x-list-ingest]
---
$NVDA breaking out above $900 with massive volume. Data center demand accelerating — Jensen just confirmed record orders at Computex. This is the move. PT $980 next 30 days. Support at $880 is solid. Blackwell supply constraint easing faster than expected.
EOF

echo "--> Seeding empty watchlist..."
gbrain_seed watchlist/current <<'EOF'
---
type: watchlist
updated_at: 2026-06-04T11:00:00Z
---

## Active Tickers

(none)
EOF

echo "--> Writing prices..."
echo '{"NVDA": { "open": 900, "current": 912, "changePct": 1.33, "updatedAt": "2026-06-04T11:30:00.000Z" }}' | \
  docker exec -i openclaw-railway-template-openclaw-1 bash -c "mkdir -p $OPENCLAW_DIR && cat > $PRICES_FILE"

echo "--> Running watchlist-builder cron (waiting 180s for agent to complete)..."
ac_run_cron trading-watchlist-builder
sleep 180

echo ""
echo "--> Asserting GBrain state..."
PLAN=$(gbrain get plans/nvda 2>/dev/null || echo "")
check "plans/nvda created in GBrain"                  "[[ -n '$PLAN' ]]"
check "plans/nvda has status: pending-confirmation"   "echo '$PLAN' | grep -q 'pending-confirmation'"
check "plans/nvda has direction field"                "echo '$PLAN' | grep -qE 'direction: (LONG|SHORT)'"
check "plans/nvda has entry, target, invalidation"    "echo '$PLAN' | grep -q 'entry:' && echo '$PLAN' | grep -q 'target:' && echo '$PLAN' | grep -q 'invalidation:'"
check "plans/nvda has conviction field"               "echo '$PLAN' | grep -q 'conviction:'"
check "plans/nvda has rr_ratio >= 2"                  "echo '$PLAN' | grep -oP 'rr_ratio: \K[\d.]+' | awk '{exit (\$1 >= 2.0) ? 0 : 1}'"

WATCHLIST=$(gbrain get watchlist/current 2>/dev/null || echo "")
check "watchlist/current updated with NVDA"           "echo '$WATCHLIST' | grep -q 'NVDA'"

WATCHLIST_JSON=$(docker exec openclaw-railway-template-openclaw-1 cat "$WATCHLIST_FILE" 2>/dev/null || echo "")
check "finnhub-watchlist.json contains NVDA"          "echo '$WATCHLIST_JSON' | grep -q 'NVDA'"

echo ""
confirm "Telegram shows plan proposal for NVDA with entry/target/invalidation and conviction"
confirm "Telegram shows RR ratio >= 2:1"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
