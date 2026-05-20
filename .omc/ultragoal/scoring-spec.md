# US Market Risk Score — Scoring Specification

**Version:** 1.0  
**Status:** G001 complete  
**Date:** 2026-05-20

---

## Overview

Given a target date, fetch OHLCV history for four tickers, compute per-factor signals, sum the bearish count, and map to a classification.

**Output:**
```
Risk Score: Caution (2/4 bearish)
  DXY  ⚠️  Breaking out  (price $106.2 > SMA20 $104.8, +1.1% 5d)
  HYG  ✅  Holding up    (price $78.4 > SMA20 $77.9, +0.1% 5d)
  SPY  ⚠️  Fading        (RSI 48, price $521 < SMA20 $528)
  VIX  ✅  Normal range  (VIX 19.4 ≥ 18)
```

---

## Tickers

| Factor | Yahoo Finance Symbol | Notes |
|--------|---------------------|-------|
| DXY | `DX-Y.NYB` | US Dollar Index |
| HYG | `HYG` | iShares HY Bond ETF |
| SPY | `SPY` | S&P 500 ETF |
| VIX | `^VIX` | CBOE Volatility Index |

---

## Data Required

For each ticker, fetch **30 calendar days** of daily OHLCV ending on the target date (to ensure ≥20 trading days for SMA). Use adjusted close prices for ETFs (HYG, SPY); use close for DXY and VIX.

**Minimum trading days needed:** 20 (for SMA20). If fewer than 20 days available, abort with an error.

---

## Per-Factor Signal Rules

### Factor 1: DXY — Dollar Breakout
**Bearish signal (risk for equities) = TRUE when BOTH:**
- `close > SMA(20)` — price above 20-day moving average
- `(close - close_5d_ago) / close_5d_ago > 0.005` — 5-day return > +0.5%

**Rationale:** A strengthening dollar tightens global financial conditions and pressures risk assets.

### Factor 2: HYG — High-Yield Bond Breakdown
**Bearish signal = TRUE when BOTH:**
- `close < SMA(20)` — price below 20-day moving average
- `(close - close_5d_ago) / close_5d_ago < -0.003` — 5-day return < -0.3%

**Rationale:** HYG leads SPY lower; a breakdown in credit is an early warning before equity selloffs.

### Factor 3: SPY — Momentum Fade
**Bearish signal = TRUE when EITHER:**
- `RSI(14) < 50` — momentum has flipped to sellers-in-control
- `close < SMA(20)` — price below medium-term trend

**Rationale:** A single condition is sufficient here — RSI below 50 OR price breaking below the 20-day MA are each meaningful signs that buying pressure is fading.

### Factor 4: VIX — At Support (Complacency)
**Bearish signal = TRUE when:**
- `close < 18` — VIX below 18 (historical support zone, market is complacent)

**Rationale:** When VIX is near its floor, upside protection is cheap but the market is priced for perfection. Any shock will cause a larger-than-expected move.

---

## RSI(14) Calculation

```
gains = [max(close[i] - close[i-1], 0) for i in 1..14]
losses = [max(close[i-1] - close[i], 0) for i in 1..14]
avg_gain = mean(gains)
avg_loss = mean(losses)
RS = avg_gain / avg_loss  (if avg_loss == 0: RS = 100)
RSI = 100 - (100 / (1 + RS))
```

Use Wilder's smoothing for subsequent values if > 14 days available, otherwise use simple mean.

---

## Composite Scoring

Each factor contributes exactly **1 point** if bearish (equal weighting, v1.0).

| Bearish Count | Classification |
|---------------|----------------|
| 0 | **Risk On** — conditions supportive of equities |
| 1 | **Neutral** — mixed signals, no strong directional bias |
| 2 | **Caution** — multiple warning signs, reduce exposure |
| 3–4 | **Risk Off** — significant stress, avoid new longs |

---

## Data Source Interface

The data fetcher must return this structure (source-agnostic):

```json
{
  "target_date": "2026-05-19",
  "trading_day": "2026-05-19",
  "tickers": {
    "DX-Y.NYB": {
      "close": 106.2,
      "sma20": 104.8,
      "close_5d_ago": 105.0,
      "rsi14": null
    },
    "HYG": {
      "close": 78.4,
      "sma20": 77.9,
      "close_5d_ago": 78.35,
      "rsi14": null
    },
    "SPY": {
      "close": 521.0,
      "sma20": 528.0,
      "close_5d_ago": 524.0,
      "rsi14": 48
    },
    "^VIX": {
      "close": 19.4,
      "sma20": null,
      "close_5d_ago": null,
      "rsi14": null
    }
  }
}
```

Fields marked `null` are not needed by the scoring rules for that ticker. The fetcher may populate them regardless for debugging.

---

## Edge Cases

| Case | Handling |
|------|----------|
| Target date is weekend / holiday | Use the most recent prior trading day; note in output |
| Ticker data unavailable | Mark factor as `unknown`, exclude from count, note in output |
| Fewer than 20 trading days of history | Error: "insufficient history for SMA20" |
| VIX spike day (> 40) | Factor 4 signal is FALSE (VIX not at support) — normal rule applies |

---

## Future: Switchable Data Source

Implement a `DataSource` interface with two concrete classes:

- `YahooFinanceBrowserSource` — agent uses browser tool to visit Yahoo Finance historical data pages
- `YahooFinanceApiSource` — calls `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=3mo&interval=1d` directly (no auth required, same data)

The scoring script only depends on the interface, not the source.
