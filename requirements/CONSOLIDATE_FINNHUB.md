# Plan: Remove finnhub-poller and finnhub-ws, consolidate into stocks-signals skill

## Problem

Three separate components write or read `finnhub-prices.json`:

- **`lib/server/finnhub-poller.js`** — server daemon, polls Finnhub `/quote` every 5 min during market hours, caches results to `finnhub-prices.json`.
- **`scripts/finnhub-ws.js`** — WebSocket script that streams real-time trade ticks from Finnhub and writes `finnhub-prices.json` on every tick. Originally intended for intraday drop detection. Not started by the server — only useful if trades are executed through Finnhub, which they are not.
- **`lib/setup/skills/stocks-signals/finnhub_signals.py`** — agent-invoked skill that calls Finnhub `/quote` (plus 5 other endpoints) per ticker on demand.

The poller duplicates what stocks-signals already does for the price field, just pre-cached to a file. The WS script is dead weight (no trades through Finnhub).

## Plan

### 1. Delete `scripts/finnhub-ws.js`

No trades go through Finnhub, so tick-stream data is worthless. Nothing in the server starts this script.

### 2. Remove `finnhubPoller` from `lib/server/startup.js` and delete `lib/server/finnhub-poller.js`

No more background daemon. Remove the `finnhubPoller` argument from `runOnboardedBootSequence` and its call site in `lib/server/init/server-lifecycle.js`.

### 3. Update `trading-price-report` SKILL.md — Step 2

Replace:
```bash
cat ~/.openclaw/finnhub-prices.json
```
With inline Finnhub `/quote` calls for each ticker found in Step 1:
```bash
curl -s "https://finnhub.io/api/v1/quote?symbol=TICKER&token=$FINNHUB_API_KEY"
```
The skill already knows exactly which tickers it needs from GBrain. Fetching live at report time gives genuinely fresh prices (not up to 5-min stale). With 5–10 active plans this is 5–10 API calls per 15-min run — well within Finnhub's 60 calls/min free limit.

### 4. Update `watchlist-builder` SKILL.md — Steps 3 and 3d

Replace reads of `~/.openclaw/finnhub-prices.json` with:
```bash
python3 /data/.openclaw/workspace/skills/stocks-signals/finnhub_signals.py TICKER --json --section price
```
Watchlist-builder already calls stocks-signals for new tickers in Step 4b — this just extends the same mechanism to existing-ticker conviction audits and entry reachability checks.

### 5. Remove `watchlist-builder` SKILL.md — Step 6

Step 6 writes `finnhub-watchlist.json` explicitly "for `finnhub-ws.js`". With the WS script gone this step has no consumer and can be deleted.

### 6. Delete runtime artifacts

`~/.openclaw/finnhub-prices.json` and `~/.openclaw/finnhub-watchlist.json` are no longer produced or consumed. They can be left to decay naturally (no code references them after these changes).

## Files changed

| File | Change |
|---|---|
| `scripts/finnhub-ws.js` | Delete |
| `lib/server/finnhub-poller.js` | Delete |
| `lib/server/startup.js` | Remove `finnhubPoller.start()` and parameter |
| `lib/server/init/server-lifecycle.js` | Remove poller wiring |
| `lib/setup/skills/trading-price-report/SKILL.md` | Step 2: inline `/quote` calls instead of file read |
| `lib/setup/skills/watchlist-builder/SKILL.md` | Steps 3, 3d: use stocks-signals script; remove Step 6 |

## Trade-offs

**What changes:** the price report now makes N live Finnhub API calls per run instead of reading a file. Data is fresher (live vs up to 5-min stale).

**What is lost:** the `open` price field that the WS drop-detection logic used — irrelevant since that feature is being removed.

**No rate limit concern:** Finnhub free tier allows 60 calls/min. Price report runs every 15 min with ~5–10 tickers. Watchlist-builder runs once daily.
