---
name: finnhub-signals
description: Fetch real-time price, analyst consensus, recent news, upcoming earnings, and fundamentals for a stock ticker using the Finnhub free-tier API. Invoke when you need current price data or market context before building or auditing a trading plan.
triggers:
  - "get stocks signal"
  - "get stocks real time price"
  - "get stocks price"
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

## JSON field definitions

```
ticker                     Stock ticker symbol (e.g. "AAPL")
name                       Company name (e.g. "Apple Inc")
industry                   Finnhub industry classification (e.g. "Technology")

price.current              Latest trade price
price.open                 Today's opening price
price.high                 Today's intraday high
price.low                  Today's intraday low
price.prev_close           Previous session's closing price
price.change_pct           % change from prev_close (positive = up)
price.change               Dollar change from prev_close

market_cap_billions        Market capitalisation in USD billions
beta                       Beta vs S&P 500 (>1 = more volatile than market)

week52.high                52-week intraday high
week52.low                 52-week intraday low

technicals                 null — requires Finnhub Premium (/indicator endpoint)
support_resistance         null — requires Finnhub Premium (/scan/support-resistance endpoint)

analyst.strong_buy         Number of analysts with Strong Buy rating
analyst.buy                Number of analysts with Buy rating
analyst.hold               Number of analysts with Hold rating
analyst.sell               Number of analysts with Sell rating
analyst.strong_sell        Number of analysts with Strong Sell rating
analyst.consensus          Derived label: "Strong Buy" | "Buy" | "Hold" | "Mixed" | "Sell" | "Unknown"
                           Strong Buy = strongBuy > buy AND (strongBuy+buy)/total ≥ 50%
                           Buy        = (buy+strongBuy)/total ≥ 50%
                           Sell       = (sell+strongSell)/total ≥ 50%
                           Hold       = bullish > bearish AND bullish ≥ 30%
                           Mixed      = otherwise

news[].headline            News headline text
news[].source              Publication name (e.g. "Reuters", "Yahoo")
news[].date                Publication date in YYYY-MM-DD format
                           (top 5 by recency, last 7 days only)

sentiment                  null — requires Finnhub Premium (/news-sentiment endpoint)

earnings_next              Next earnings date in YYYY-MM-DD format, or null if none in 90 days
earnings_days_away         Integer days until earnings_next, or null

fundamentals.pe            Price/Earnings ratio (TTM, excludes extraordinary items)
fundamentals.pb            Price/Book ratio (annual)
fundamentals.ps            Price/Sales ratio (annual)
fundamentals.gross_margin_pct  Gross profit margin % (TTM); e.g. 47.9 means 47.9%
fundamentals.net_margin_pct    Net profit margin % (TTM); e.g. 27.1 means 27.1%
```
