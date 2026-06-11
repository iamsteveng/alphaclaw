---
name: finnhub-signals
description: Fetch real-time price, analyst consensus, recent news, upcoming earnings, and fundamentals for a stock ticker using the Finnhub free-tier API. Invoke when you need current price data or market context before building or auditing a trading plan.
triggers:
  - "get signals"
  - "fetch signals"
  - "stock signals"
  - "price and signals"
  - "finnhub signals"
---

# Finnhub Signals

Fetches a signal report for a single ticker from the Finnhub free-tier API. Covers price, fundamentals, analyst consensus, recent news, and upcoming earnings. Designed to be called before generating or auditing a trading plan.

## Usage

```bash
# Full report (human-readable)
python3 /data/.openclaw/workspace/skills/finnhub-signals/finnhub_signals.py AAPL

# Machine-readable JSON (for downstream processing)
python3 /data/.openclaw/workspace/skills/finnhub-signals/finnhub_signals.py AAPL --json

# Specific section only
python3 /data/.openclaw/workspace/skills/finnhub-signals/finnhub_signals.py AAPL --section price
python3 /data/.openclaw/workspace/skills/finnhub-signals/finnhub_signals.py AAPL --section analyst
python3 /data/.openclaw/workspace/skills/finnhub-signals/finnhub_signals.py AAPL --section news
```

Requires `FINNHUB_API_KEY` to be set in the environment.

## What it fetches (free tier)

| Section | Data |
|---------|------|
| Price | Current, open, high, low, prev close, % change, 52W range, market cap, beta |
| Analyst | Buy/hold/sell counts, consensus label |
| News | Top 5 headlines from last 7 days |
| Earnings | Next earnings date and days until it |
| Fundamentals | P/E, P/B, P/S, gross margin, net margin |

**Not available on free tier:** RSI/MACD/Bollinger Bands, SMA/EMA, support/resistance, price targets, sentiment scores — these require Finnhub Premium (`/indicator`, `/scan/support-resistance`, `/stock/price-target`, `/news-sentiment`).

## Rate limits

~6 API calls per run. Finnhub free tier allows 60 calls/min.

## Integration with trading plan workflow

Call this skill at the start of any plan generation or audit:

```
Step 1: Run: python3 /data/.openclaw/workspace/skills/finnhub-signals/finnhub_signals.py TICKER --json
        Use the output for current price, analyst consensus, and news context when
        populating entry, target, invalidation, and conviction fields.
```

The `--json` output can be consumed directly by other skills (e.g. watchlist-builder).
