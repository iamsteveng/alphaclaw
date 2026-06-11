#!/usr/bin/env bash
# Registers the three trading advisor cron jobs.
# Run inside the container (npm run dev:shell).
# Auto-detects Telegram delivery from the alphaclaw sessions API.
# Usage: bash setup-trading-crons.sh

set -euo pipefail

PORT="${PORT:-3000}"
PASSWORD="${SETUP_PASSWORD:-62875094}"
COOKIES_FILE="/tmp/ac-setup-cookies.txt"

echo "==> Detecting Telegram delivery config..."
curl -s -c "$COOKIES_FILE" -X POST "http://localhost:$PORT/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" > /dev/null

SESSIONS=$(curl -s -b "$COOKIES_FILE" "http://localhost:$PORT/api/agent/sessions")
TELEGRAM_TO=$(echo "$SESSIONS" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for s in data.get('sessions', []):
    if s.get('channel') == 'telegram' and s.get('replyTo'):
        print(s['replyTo'])
        break
" 2>/dev/null || true)

if [[ -z "$TELEGRAM_TO" ]]; then
  echo "Error: No Telegram session found. Pair the Telegram bot first, then re-run."
  exit 1
fi

echo "    Delivering to: telegram -> $TELEGRAM_TO"

DELIVERY_FLAGS="--announce --channel telegram --to $TELEGRAM_TO"

echo "==> Registering trading-watchlist-builder (19:30 HKT weekdays)"
HOME=/data openclaw cron add \
  --name trading-watchlist-builder \
  --cron "30 11 * * 1-5" \
  --tz UTC \
  --agent main \
  --session isolated \
  --message "Run the watchlist-builder skill. Query GBrain for recent content (last 24h), fetch watchlist/current, get the market risk score, then process each ticker: audit conviction on existing plans, generate new plans for new tickers. Apply all policy gates (max 10 plans, conflict detection, RR >= 2:1, market risk overlay). Save pending plans to GBrain plans/<TICKER> with status: pending-confirmation. Update watchlist/current. Write ~/.openclaw/finnhub-watchlist.json with the full ticker list. End with the standard Watchlist Builder announcement format." \
  $DELIVERY_FLAGS \
  --timeout 600

echo "==> Registering trading-price-report (every 15 min, first 2h US market)"
HOME=/data openclaw cron add \
  --name trading-price-report \
  --cron "*/15 13-15 * * 1-5" \
  --tz UTC \
  --agent main \
  --session isolated \
  --message "Read ~/.openclaw/finnhub-prices.json for current prices. Read all pages under plans/ in GBrain with status: active. For each active plan, calculate the distance between current price and entry price as a percentage. Emit an Approaching alert for any plan within 2% of its entry price. Then emit a full watchlist summary: ticker, direction, entry, current price, distance-to-entry %, conviction. Format clearly for Telegram." \
  $DELIVERY_FLAGS \
  --timeout 120

echo "==> Registering trading-eod-loop (16:10 HKT weekdays)"
HOME=/data openclaw cron add \
  --name trading-eod-loop \
  --cron "10 8 * * 1-5" \
  --tz UTC \
  --agent main \
  --session isolated \
  --message "EOD learning loop. Fetch all pages under plans/ in GBrain (status: active and any closed or invalidated this week). For each plan, use the Finnhub REST API (finnhub SDK, stockCandles endpoint) to get today's OHLCV data and compare against the plan's entry, target, and invalidation levels. Identify gaps: missed entries, breached invalidations not yet closed, conviction drift vs actual price movement. Propose calibration improvements to conviction scoring, RR thresholds, and market risk overlay weight. Write a full analysis to GBrain under learning/<YYYY-MM-DD> (today's date). End with a summary announcement. Never auto-apply any changes — all proposals require Steve's confirmation." \
  $DELIVERY_FLAGS \
  --timeout 300

echo ""
echo "==> Done. Registered crons:"
HOME=/data openclaw cron list | grep -E "trading-(watchlist-builder|price-report|eod-loop)" || HOME=/data openclaw cron list
