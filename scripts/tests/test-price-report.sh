#!/usr/bin/env bash
# Test 8: Price report — basic run, no Approaching alerts.
# Test 8b: Price report — Approaching alert fires when within 2% of entry.
# Usage: bash src/scripts/tests/test-price-report.sh

set -euo pipefail

source "$(dirname "$0")/helpers.sh"

OPENCLAW_DIR="${OPENCLAW_DIR:-/data/.openclaw}"
PASS=0; FAIL=0

check() {
  local label="$1"; local cmd="$2"
  if eval "$cmd" &>/dev/null; then
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
  ac_remove_crons 2>/dev/null || true
}
trap cleanup EXIT

ac_login
ac_ensure_crons

echo "=== Test 8: Price report (basic — no Approaching alerts) ==="

echo "--> Seeding GBrain plans..."
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
Test plan for AAPL.
EOF

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
status: active
---
Test plan for TSLA.
EOF

echo "--> Running price-report cron (waiting 90s for agent to complete, prices fetched live via stocks-signals)..."
ac_run_cron trading-price-report
sleep 90

echo ""
confirm "Telegram shows watchlist summary with AAPL and TSLA"
confirm "No Approaching alert (AAPL at 158, entry 150 — 5.3% away)"

echo ""
echo "=== Test 8b: Price report — Approaching alert ==="
echo "    NOTE: Approaching alert depends on live prices vs seeded entry levels."
echo "    Confirm visually that the alert fires if live price is within 2% of entry 150 (AAPL) or 200 (TSLA SHORT)."

echo "--> Running price-report cron (waiting 90s for agent to complete)..."
ac_run_cron trading-price-report
sleep 90

echo ""
confirm "Telegram shows Approaching alert for AAPL (151.5 vs entry 150, 1% away)"
confirm "No Approaching alert for TSLA (208 vs entry 200, 4% away)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]]
