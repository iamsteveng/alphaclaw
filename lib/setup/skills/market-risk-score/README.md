# Market Risk Score — Skill

Composite US equity risk monitor using four market factors: **$DXY**, **$HYG**, **$SPY**, and **$VIX**. Each factor runs a multi-signal scoring model (0–10) tuned to detect conditions that precede a ≥5% SPY drawdown within 14 trading days.

## Files

| File | Purpose |
|------|---------|
| `market_risk_score.py` | Main scoring script — run daily for a risk reading |
| `backtest_market_risk_score.py` | Walk-forward backtesting harness — evaluate and tune the model |
| `backtest_new_signals.py` | Standalone backtest for candidate new signals (June 2026) |
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
US Market Risk Score — 2026-06-05
🔴 Risk Off (3/4 bearish signals) — significant stress, avoid new longs

  ✅ $DXY (Dollar)          Bullish   3/10 Early warning — SMA stack +1, SMA20>SMA50 +1
  🔴 $HYG (HY Bonds)        Bearish   4/10 Early credit warning — div -4.5%, SMA stack
  🔴 $SPY (S&P 500)         Bearish   4/10 Early equity warning — MACD↓, reversal 2.01×ATR ★, IWM spread -0.5pp ★
  🔴 $VIX (Volatility)      Bearish   2/10 VIX complacent / no signal — ROC5 +40%, VIX 21.5

New signals (experimental):
  ★ [new] SPY intraday reversal: (High−Close)/ATR14 = 2.00× (≥1.0 threshold) — sellers dominated intraday; close-to-high gap exceeds a full ATR. +1 to SPY score. [backtest: precision 0.25, fires ~9% of days]
  ★ [new] IWM/SPY breadth spread: IWM lags SPY by -0.52pp over 5d (< −0.5pp threshold) — small-cap underperformance signals risk rotation. +1 to SPY score. [backtest: TPR 0.42, F2 0.34, fires ~41% of days]
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
| $SPY | 11 signals | ≥3/10 | SMA200+slope, MACD histogram, ROC acceleration, Z-score, HV rising, SMA50 slope, BB expansion, drawdown, **intraday reversal ★**, **IWM breadth spread ★** |
| $VIX | 9 signals | ≥1/10 | Low-base spike, moderate spike, Z-score, sustained>SMA20, SMA10 ratio, absolute level, VIX/SPY correlation, consecutive up days, contango proxy |

★ Experimental signals added June 2026 — see New Signals section below.

### New signals (experimental, June 2026)

Two signals were added to the $SPY model after backtesting 5 years of data (target: ≥5% SPY drop within 20 trading days, F2-optimised).

**SPY intraday reversal** — `(High − Close) / ATR14 ≥ 1.0` → +1 to SPY score

The close-to-high gap as a multiple of the 14-day ATR. A ratio ≥ 1.0 means sellers reclaimed more than a full ATR from the intraday high — distribution pattern. Requires SPY OHLC data (fetched automatically from Yahoo Finance; optional in browser-json mode).

| Backtest stat | Value |
|--------------|-------|
| Fire rate | ~9% of trading days |
| Precision | 0.250 (vs 0.196 base rate — highest of all new candidates) |
| TPR at threshold | 0.121 |
| Note | High-confidence, low-frequency flag |

**IWM/SPY breadth divergence** — `IWM 5d ROC − SPY 5d ROC < −0.5pp` → +1 to SPY score

Small-cap (IWM) underperformance vs large-cap (SPY) over 5 days signals risk-appetite deterioration. When the Russell 2000 lags the S&P 500, institutional rotation out of risk is already underway. IWM is fetched automatically; not required in browser-json mode.

| Backtest stat | Value |
|--------------|-------|
| Fire rate | ~41% of trading days |
| TPR (recall) | 0.42 |
| F2 score | 0.34 |
| Note | Best used as a composite confirmation vote, not standalone |

Both signals are shown in the `New signals (experimental):` footer block with their live values, trigger status, and backtest context on every run.

### Data fetched

| Symbol | Source | Purpose |
|--------|--------|---------|
| `DX-Y.NYB` | Yahoo Finance, 1Y OHLC | DXY scoring (ATR, ADX, BB) |
| `HYG` | Yahoo Finance, 3mo close | Credit stress score |
| `SPY` | Yahoo Finance, 1Y close + 1Y OHLC | SPY score + intraday reversal ★ |
| `^VIX` | Yahoo Finance, 3mo close | Volatility regime score |
| `IWM` | Yahoo Finance, 3mo close | SPY breadth divergence ★ |

### Switching data source

Default source is Yahoo Finance public JSON API (no auth). To provide browser-fetched data:

```bash
python3 market_risk_score.py \
  --source browser-json \
  --data '{
    "DX-Y.NYB": [{"date":"YYYY-MM-DD","high":N,"low":N,"close":N},...],
    "HYG":  [{"date":"YYYY-MM-DD","close":N},...],
    "SPY":  [{"date":"YYYY-MM-DD","close":N},...],
    "^VIX": [{"date":"YYYY-MM-DD","close":N},...]
  }'
```

Optionally add `"high"` and `"low"` to SPY rows to enable the intraday reversal signal, and add an `"IWM"` key for the breadth divergence signal. If either is absent, the corresponding signal is silently skipped and shows `n/a` in the output.

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
| `spy_intraday_rev` | (High−Close)/ATR14 ratio for the day |
| `spy_breadth_spread` | IWM−SPY 5d return spread in percentage points |
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

---

## backtest_new_signals.py

Standalone backtest for the five candidate new signals evaluated in June 2026 (20-day forward window, ≥5% SPY drop target). Results informed which signals were promoted to `market_risk_score.py`.

| Signal | Best practical F2 | Fire rate | Notes |
|--------|------------------|-----------|-------|
| SPY intraday reversal (≥1.0×ATR) | 0.135 (prec 0.250) | 9% | Highest precision; promoted ★ |
| IWM/SPY 5d spread (<−0.5pp) | 0.342 | 41% | Best recall; promoted ★ |
| TLT 5d ROC (>1%) | 0.205 | 26% | Low precision; not promoted |
| VIX/SPY 10d corr (>−0.4) | 0.050 | 6% | Weak in isolation; already in VIX score |
| VIX9D/VIX ratio | n/a | n/a | ^VXST unavailable on Yahoo Finance |
