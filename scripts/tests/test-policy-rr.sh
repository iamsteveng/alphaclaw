#!/usr/bin/env bash
# Test 14: Policy gate — RR < 2:1 plan rejected, RR >= 2:1 plan accepted.
# Seeds two tickers via GBrain content: MSFT (RR ~2.0, should pass) and GOOG (RR ~1.2, should fail).
# Usage: bash src/scripts/tests/test-policy-rr.sh

set -euo pipefail

source "$(dirname "$0")/helpers.sh"

OPENCLAW_DIR="${OPENCLAW_DIR:-/data/.openclaw}"
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
  gbrain delete plans/msft 2>/dev/null || true
  gbrain delete plans/goog 2>/dev/null || true
  gbrain delete twitter/post/test-rr-msft 2>/dev/null || true
  gbrain delete twitter/post/test-rr-goog 2>/dev/null || true
  gbrain delete watchlist/current 2>/dev/null || true
  ac_remove_crons 2>/dev/null || true
}
trap cleanup EXIT

ac_login
ac_ensure_crons

echo "=== Test 14: Policy gate — RR rejection ==="
echo "    MSFT: entry 100, target 120, invalidation 90 → RR = (120-100)/(100-90) = 2.0 ✅"
echo "    GOOG: entry 100, target 106, invalidation 95 → RR = (106-100)/(100-95) = 1.2 ❌"

echo "--> Seeding GBrain content for MSFT (RR = 2.0, just passes)..."
gbrain_seed twitter/post/test-rr-msft <<'EOF'
---
type: tweet
tweet_id: test-rr-msft
author: "@techtrader"
posted_at: 2026-06-04T10:00:00Z
tags: [twitter, x-list-ingest]
---
$MSFT breaking out above $100 resistance with strong volume. Azure growth accelerating. Entry at $100, clear target at $120 (next major resistance), invalidation below $90 (prior support). Copilot monetization is the catalyst. Risk/reward is solid here.
EOF

echo "--> Seeding GBrain content for GOOG (RR = 1.2, should fail)..."
gbrain_seed twitter/post/test-rr-goog <<'EOF'
---
type: tweet
tweet_id: test-rr-goog
author: "@adtrader"
posted_at: 2026-06-04T10:05:00Z
tags: [twitter, x-list-ingest]
---
$GOOG advertising recovery underway. Entry at $100, target $106 (gap fill), invalidation at $95 (200-day MA). Search share holding despite AI headwinds. Not a huge mover but a clean setup.
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

echo "--> Running watchlist-builder cron (waiting 180s; agent fetches live price via stocks-signals)..."
ac_run_cron trading-watchlist-builder
sleep 180

echo ""
echo "--> Asserting GBrain state..."
MSFT_PLAN=$(gbrain get plans/msft 2>/dev/null || echo "")
GOOG_PLAN=$(gbrain get plans/goog 2>/dev/null || echo "")

check "plans/msft created (RR 2.0 passes)"       "[[ -n '$MSFT_PLAN' ]]"
check "plans/msft has rr_ratio >= 2.0"            "echo '$MSFT_PLAN' | grep -oP 'rr_ratio: \K[\d.]+' | awk '{exit (\$1 >= 2.0) ? 0 : 1}'"
check "plans/goog does NOT exist (RR 1.2 fails)"  "[[ -z '$GOOG_PLAN' ]]"

echo ""
confirm "Telegram shows MSFT plan proposal (RR 2.0 accepted)"
confirm "Telegram shows GOOG rejected with RR reason (1.2 below minimum 2:1)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
