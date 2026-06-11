---
name: market-risk-score
description: Calculate US market risk score (Risk On/Neutral/Caution/Risk Off) from DXY, HYG, SPY, VIX using Yahoo Finance data. Invoke when the user asks for market risk, risk score, risk on/off, or DXY/HYG/SPY/VIX composite signals.
triggers:
  - "market risk score"
  - "market risk"
---

# Market Risk Score

Runs a Python script that fetches daily OHLCV data from Yahoo Finance and applies four factor scoring models to produce a composite risk classification. Each factor runs a multi-signal model (0–10) tuned to detect conditions that precede a ≥5% SPY drawdown within 14–20 trading days.

## Usage

```bash
# Today
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py

# Named day or specific date
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --date "last monday"
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --date 2026-05-16

# Machine-readable JSON (for downstream use)
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --date today --json

# DXY deep-dive only
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --dxy-only
```

Weekend/holiday dates automatically roll back to the prior trading day.

## Factors

| Factor | Ticker | Signals | Bearish threshold | Key indicators |
|--------|--------|---------|------------------|----------------|
| Dollar | $DXY | 13 | ≥7/10 | Breakout levels, SMA stack, ROC, Z-score, ATR, ADX, Bollinger Bands, SPY/HYG divergence |
| HY Bonds | $HYG | 9 | ≥4/10 | Z-score, HYG/SPY 20d divergence, ROC10/20, SMA stack, RSI danger zone, SMA crossovers, Bollinger %B |
| S&P 500 | $SPY | 11 | ≥3/10 | SMA200+slope, MACD histogram, ROC acceleration, Z-score, HV rising, SMA50 slope, BB expansion, drawdown, intraday reversal ★, IWM breadth spread ★ |
| Volatility | $VIX | 9 | ≥1/10 | Low-base spike, moderate spike, Z-score, sustained>SMA20, SMA10 ratio, absolute level, VIX/SPY correlation, consecutive up days, contango proxy |

★ Experimental signals added June 2026 — see New Signals section below.

## Classification

| Bearish signals | Result |
|----------------|--------|
| 0 | ✅ Risk On |
| 1 | 🟡 Neutral |
| 2 | ⚠️ Caution |
| 3–4 | 🔴 Risk Off |

## New Signals (experimental, added June 2026)

Two additional signals were added to the $SPY scoring model after backtesting against 5 years of data (2021–2026) targeting ≥5% SPY drops within 20 trading days.

### SPY Intraday Reversal

`(SPY High − SPY Close) / ATR14 ≥ 1.0` → **+1 to SPY score**

Measures how much of the daily high-to-close range was given back into the close. A ratio ≥ 1.0 means the close-to-high gap exceeds a full 14-day ATR — sellers dominated the session despite an intraday rally.

| Metric | Value |
|--------|-------|
| Threshold | ≥ 1.0 × ATR14 |
| Fire rate | ~9% of trading days |
| Precision | 0.250 (vs 0.196 base rate) |
| Requires | SPY OHLC (high/low/close) |

### IWM/SPY Breadth Divergence

`IWM 5d ROC − SPY 5d ROC < −0.5pp` → **+1 to SPY score**

Small-cap underperformance relative to large-cap signals risk-appetite deterioration at the margin. When the Russell 2000 (IWM) lags the S&P 500 (SPY) over 5 days, institutional rotation out of higher-risk equities is already underway.

| Metric | Value |
|--------|-------|
| Threshold | IWM lags SPY by > 0.5 percentage points over 5 days |
| Fire rate | ~41% of trading days |
| TPR (recall) | 0.42 |
| F2 score | 0.34 |
| Requires | IWM close data |

Both signals are displayed in a `New signals (experimental):` block at the bottom of the human-readable output, showing their current value, whether they triggered, and the backtest stats as context.

## Switching data source

Default source is Yahoo Finance public JSON API (no auth). To provide browser-fetched data:

```bash
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py \
  --source browser-json \
  --data '{
    "DX-Y.NYB": [{"date":"YYYY-MM-DD","high":N,"low":N,"close":N},...],
    "HYG":  [{"date":"YYYY-MM-DD","close":N},...],
    "SPY":  [{"date":"YYYY-MM-DD","close":N},...],
    "^VIX": [{"date":"YYYY-MM-DD","close":N},...]
  }'
```

To enable the experimental SPY signals, optionally include:
- `"high"` and `"low"` fields in SPY rows (enables intraday reversal signal)
- `"IWM"` key with close-only rows (enables breadth divergence signal)

Each ticker list must contain ≥20 trading days sorted ascending. DXY must cover ≥210 days. IWM must cover ≥6 days if provided.
