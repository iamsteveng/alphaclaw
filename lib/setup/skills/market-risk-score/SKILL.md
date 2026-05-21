---
name: market-risk-score
description: Calculate US market risk score (Risk On/Neutral/Caution/Risk Off) from DXY, HYG, SPY, VIX using Yahoo Finance data. Invoke when the user asks for market risk, risk score, risk on/off, or DXY/HYG/SPY/VIX composite signals.
---

# Market Risk Score

Runs a Python script that fetches 3 months of OHLCV data from Yahoo Finance and applies four factor rules to produce a composite risk classification.

## Usage

```bash
# Today
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py

# Named day or specific date
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --date "last monday"
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --date 2026-05-16

# Machine-readable JSON (for downstream use)
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --date today --json
```

Weekend/holiday dates automatically roll back to the prior trading day.

## Factors

| Factor | Ticker | Bearish signal |
|--------|--------|----------------|
| Dollar | $DXY | Price > SMA20 AND 5d return > +0.5% |
| HY Bonds | $HYG | Price < SMA20 AND 5d return < −0.3% |
| S&P 500 | $SPY | RSI(14) < 50 OR price < SMA20 |
| Volatility | $VIX | Level < 18 (complacency) |

## Classification

| Bearish signals | Result |
|----------------|--------|
| 0 | ✅ Risk On |
| 1 | 🟡 Neutral |
| 2 | ⚠️ Caution |
| 3–4 | 🔴 Risk Off |

## Switching data source

Default source is Yahoo Finance public JSON API (no auth). To provide browser-fetched data:

```bash
python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py \
  --source browser-json \
  --data '{"DX-Y.NYB":[{"date":"YYYY-MM-DD","close":N},...], "HYG":[...], "SPY":[...], "^VIX":[...]}'
```

Each ticker list must contain ≥25 trading days sorted ascending.
