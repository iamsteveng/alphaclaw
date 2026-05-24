# Market Risk Score — Skill

Composite US equity risk monitor using four market factors: **$DXY**, **$HYG**, **$SPY**, and **$VIX**. Each factor runs a multi-signal scoring model (0–10) tuned to detect conditions that precede a ≥5% SPY drawdown within 14 trading days.

## Files

| File | Purpose |
|------|---------|
| `market_risk_score.py` | Main scoring script — run daily for a risk reading |
| `backtest_market_risk_score.py` | Walk-forward backtesting harness — evaluate and tune the model |
| `SKILL.md` | Skill manifest for OpenClaw agent discovery |

---

## market_risk_score.py

### Usage

```bash
python3 market_risk_score.py                      # today's score
python3 market_risk_score.py --date 2026-05-16    # specific date
python3 market_risk_score.py --date "last friday"
python3 market_risk_score.py --json               # machine-readable output
python3 market_risk_score.py --dxy-only           # DXY deep-dive only
```

### Output example

```
US Market Risk Score — 2026-05-22
🟡 Neutral (1/4 bearish signals) — mixed signals, no strong directional bias

  ✅ $DXY (Dollar)          Bullish   3/10 Early warning — SMA stack, ROC10 +1.5%
  🔴 $HYG (HY Bonds)        Bearish   4/10 Early credit warning — div -5.1%, < SMA20
  🟡 $SPY (S&P 500)         Caution   2/10 No meaningful SPY pressure — MACD↓
  ✅ $VIX (Volatility)      Bullish   0/10 VIX complacent / no signal
```

### Composite classification

| Bearish signals | Label | Meaning |
|----------------|-------|---------|
| 0 | Risk On | Conditions supportive of equities |
| 1 | Neutral | Mixed signals, no strong directional bias |
| 2 | Caution | Multiple warning signs, consider reducing exposure |
| 3–4 | Risk Off | Significant stress, avoid new longs |

### Factor scoring models

| Factor | Signals | Bearish threshold | Key indicators |
|--------|---------|------------------|----------------|
| $DXY | 13 signals | ≥7/10 | Breakout levels, SMA stack, ROC, Z-score, ATR, ADX, Bollinger Bands, SPY/HYG divergence |
| $HYG | 9 signals | ≥4/10 | Z-score, HYG/SPY 20d divergence, ROC10/20, SMA stack, RSI danger zone, SMA crossovers, Bollinger %B |
| $SPY | 9 signals | ≥3/10 | SMA200+slope, MACD histogram, ROC acceleration, Z-score, HV rising, SMA50 slope, BB expansion, drawdown |
| $VIX | 9 signals | ≥1/10 | Low-base spike, moderate spike, Z-score, sustained>SMA20, SMA10 ratio, absolute level, VIX/SPY correlation, consecutive up days, contango proxy |

---

## backtest_market_risk_score.py

### What it does

Downloads historical data from Yahoo Finance (free, no auth) and runs a **walk-forward backtest**: for every trading day with sufficient history, it computes the four factor scores, then checks whether SPY dropped ≥5% within the next 14 trading days. It reports classification metrics at every threshold so you can evaluate and tune the model.

### Usage

```bash
# Default: 5-year backtest, ≥5% drop, 14-day window
python3 backtest_market_risk_score.py

# Custom parameters
python3 backtest_market_risk_score.py --years 10       # 10 years of history
python3 backtest_market_risk_score.py --drop-pct 7     # target ≥7% drops only
python3 backtest_market_risk_score.py --window 10      # 10-day forward window

# Export per-day results for further analysis
python3 backtest_market_risk_score.py --csv results.csv
```

### Output sections

**Composite threshold table** — confusion matrix and F1/F2 scores at each level (≥1 through ≥4 bearish factors):

```
Composite (how many of the 4 factors are bearish)
  Thresh      TP     FP     TN    FN     TPR    FPR   Prec     F1         F2
  ≥1          93    358    712    60   60.8%  33.5%  20.6%  0.308 ◄F1  0.437 ◄F2
  ≥2          49    172    898   104   32.0%  16.1%  22.2%  0.262       0.294
  ...
```

**Individual factor table** — per-factor TPR, FPR, F1, F2 at current thresholds.

**Score distribution** — average score on days that preceded a drop vs days that did not, confirming each factor's predictive separation.

**Threshold sensitivity** — for each factor, shows which score threshold maximises F1 and which maximises F2 across 0–10, so you can tune bearish thresholds with evidence.

**True positive breakdown** — magnitude distribution of drops caught by the model (3–6%, 6–10%, >10%).

### Metrics glossary

| Metric | Formula | What it means |
|--------|---------|---------------|
| TPR (recall) | TP / (TP + FN) | Fraction of actual drops that were flagged |
| FPR | FP / (FP + TN) | Fraction of non-drop days that were falsely flagged |
| Precision | TP / (TP + FP) | Fraction of flags that were real drops |
| F1 | harmonic mean of precision and TPR | Balanced score — penalises both missed drops and false alarms equally |
| F2 | weighted harmonic mean (recall weighted 2×) | Recall-biased score — missing a crash costs more than a false alarm |

**F2 is the recommended optimisation target** for a risk-off signal because the cost of missing a 10% crash outweighs the cost of an extra cautious day.

### CSV columns

| Column | Description |
|--------|-------------|
| `date` | Trading day |
| `dxy_score` / `hyg_score` / `spy_score` / `vix_score` | Raw 0–10 scores |
| `dxy_bearish` … `vix_bearish` | Boolean bearish flags at current thresholds |
| `composite` | Number of bearish factors (0–4) |
| `label` | True if SPY dropped ≥5% in the next N trading days |
| `fwd_drawdown` | Actual SPY forward drawdown (%) |

### Backtest results (5Y, May 2021 – May 2026)

| | Value |
|--|--|
| Evaluation days | 1,223 |
| Base rate (drops ≥5% in 14d) | 12.5% |
| Best composite threshold (F2) | ≥1 (any factor bearish) |
| TPR at composite ≥1 | 60.8% |
| FPR at composite ≥1 | 33.5% |
| F2 at composite ≥1 | 0.437 |
| Avg forward drawdown on true positives | 7.0% |
