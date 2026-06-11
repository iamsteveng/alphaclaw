# DXY Equity Risk Monitor Requirement

## 1. Purpose

This document defines the monitoring requirements for detecting the market condition:

> **Dollar Index (DXY) is breaking out, which may become a negative signal for equities.**

The purpose of this monitor is to identify when U.S. dollar strength becomes meaningful enough to increase equity market risk, especially when confirmed by weakness in SPY, HYG, or broader risk assets.

This monitor should be used as part of a broader market risk dashboard, not as a standalone buy/sell signal.

---

## 2. Core Market Logic

A rising U.S. dollar can be negative for equities because it may indicate tightening financial conditions, global risk-off behavior, pressure on emerging markets, weaker commodity sentiment, and potential earnings translation headwinds for U.S. multinational companies.

However, DXY strength alone is not always bearish. The signal becomes more important when:

1. DXY breaks above a multi-month range.
2. DXY trend momentum strengthens.
3. The move is statistically or volatility-adjusted significant.
4. Equity or credit markets confirm the stress.

---

## 3. Required Data Inputs

The script should collect daily OHLCV data where available.

### 3.1 Required Symbols

| Symbol | Asset | Required Fields |
|---|---|---|
| DXY | U.S. Dollar Index | Open, High, Low, Close |
| SPY | S&P 500 ETF | Close |
| HYG | High Yield Bond ETF | Close |

### 3.2 Optional Symbols

| Symbol | Asset | Use Case |
|---|---|---|
| VIX | Volatility Index | Equity volatility confirmation |
| UUP | Dollar Bullish ETF | Alternative if DXY data unavailable |
| EURUSD | Euro / U.S. Dollar | DXY component confirmation |

---

## 4. Signal 1: DXY Price Breakout Above Recent Range

### Requirement

Detect whether DXY has closed above its previous 60-day high.

### Formula

```text
DXY_Close_today > Highest(DXY_Close, 60 days, excluding today)
```

### Python Logic

```python
rolling_high_60 = dxy_close.shift(1).rolling(60).max()
signal_breakout_60d = dxy_close > rolling_high_60
```

### Signal Strength

| Strength | Requirement |
|---|---|
| Mild breakout | DXY close above prior 60-day high |
| Strong breakout | DXY close above prior 90-day high |
| Major breakout | DXY close above prior 120-day high |

### Why It Matters

A close above a multi-month high suggests the dollar is moving from range-bound behavior into trend breakout mode. This may tighten global financial conditions and create headwinds for equities.

---

## 5. Signal 2: Breakout Confirmation

### Requirement

Avoid treating a single-day spike as a confirmed breakout.

### Formula

```text
DXY closes above prior 60-day high for at least 2 out of the latest 3 trading days
```

### Python Logic

```python
above_60d_high = dxy_close > dxy_close.shift(1).rolling(60).max()
confirmed_breakout = above_60d_high.rolling(3).sum() >= 2
```

### Why It Matters

One-day breakouts can be false signals caused by macro news, CPI/Fed events, or temporary FX volatility. Requiring confirmation improves reliability.

---

## 6. Signal 3: Moving Average Trend Structure

### Requirement

Monitor whether DXY is above key moving averages and whether the moving averages are aligned bullishly.

### Basic Trend Requirement

```text
DXY_Close > SMA_20
AND
DXY_Close > SMA_50
AND
SMA_20 > SMA_50
```

### Strong Trend Requirement

```text
DXY_Close > SMA_20 > SMA_50 > SMA_200
```

### Python Logic

```python
sma20 = dxy_close.rolling(20).mean()
sma50 = dxy_close.rolling(50).mean()
sma200 = dxy_close.rolling(200).mean()

trend_stack_basic = (dxy_close > sma20) & (dxy_close > sma50) & (sma20 > sma50)
trend_stack_strong = (dxy_close > sma20) & (sma20 > sma50) & (sma50 > sma200)
```

### Why It Matters

A breakout is more reliable when supported by trend alignment. DXY above its 20-day and 50-day moving averages shows that short- and medium-term dollar momentum is positive.

---

## 7. Signal 4: DXY Rate of Change Momentum

### Requirement

Measure how quickly DXY is rising.

### Formula

```text
DXY_10D_ROC = DXY_Close_today / DXY_Close_10_days_ago - 1

DXY_20D_ROC = DXY_Close_today / DXY_Close_20_days_ago - 1
```

### Python Logic

```python
dxy_roc10 = dxy_close / dxy_close.shift(10) - 1
dxy_roc20 = dxy_close / dxy_close.shift(20) - 1
```

### Thresholds

| Signal | Requirement |
|---|---|
| Mild USD pressure | DXY 10D ROC > +1.0% |
| Strong USD pressure | DXY 10D ROC > +1.5% |
| Major USD pressure | DXY 20D ROC > +2.5% |

### Why It Matters

Equities can often tolerate a slow dollar rise, but a fast dollar spike may indicate risk-off behavior, global liquidity pressure, or a flight to U.S. dollar safety.

---

## 8. Signal 5: DXY Z-Score

### Requirement

Determine whether the DXY move is statistically unusual relative to recent behavior.

### Formula

```text
DXY_Z = (DXY_Close - SMA_60) / STD_60
```

### Python Logic

```python
sma60 = dxy_close.rolling(60).mean()
std60 = dxy_close.rolling(60).std()
dxy_z = (dxy_close - sma60) / std60
```

### Thresholds

| Signal | Requirement |
|---|---|
| Elevated dollar | DXY Z-score > +1.0 |
| Strong dollar stress | DXY Z-score > +1.5 |
| Extreme dollar stress | DXY Z-score > +2.0 |

### Why It Matters

A high z-score shows that DXY is not merely drifting higher. It is stretched relative to its recent distribution, which may indicate broader macro stress.

---

## 9. Signal 6: ATR-Adjusted Breakout

### Requirement

Avoid treating tiny breakouts as meaningful. DXY should close above resistance by a volatility-adjusted buffer.

### Formula

```text
DXY_Close > Prior_60D_High + 0.25 × ATR_14
```

### True Range Formula

```text
TR = max(
    High - Low,
    abs(High - Previous_Close),
    abs(Low - Previous_Close)
)
```

### ATR Formula

```text
ATR_14 = Average(True Range, 14 days)
```

### Python Logic

```python
tr = pd.concat([
    dxy_high - dxy_low,
    (dxy_high - dxy_close.shift(1)).abs(),
    (dxy_low - dxy_close.shift(1)).abs()
], axis=1).max(axis=1)

atr14 = tr.rolling(14).mean()
prior_high_60 = dxy_close.shift(1).rolling(60).max()

atr_breakout = dxy_close > prior_high_60 + 0.25 * atr14
```

### Why It Matters

A close barely above resistance may not be meaningful. ATR adjustment requires the breakout to exceed normal daily volatility noise.

---

## 10. Signal 7: DXY ADX Trend Strength

### Requirement

Confirm whether DXY is trending, not just moving randomly.

### Indicator

Use 14-day ADX.

### Signal Requirement

```text
ADX_14 > 20
AND
+DI > -DI
```

### Strong Signal Requirement

```text
ADX_14 > 25
AND
+DI > -DI
```

### Formula Summary

```text
+DM = Current_High - Previous_High, if greater than Previous_Low - Current_Low and > 0

-DM = Previous_Low - Current_Low, if greater than Current_High - Previous_High and > 0

+DI = 100 × Smoothed(+DM) / ATR

-DI = 100 × Smoothed(-DM) / ATR

DX = 100 × abs(+DI - -DI) / (+DI + -DI)

ADX = Smoothed average of DX
```

### Why It Matters

ADX helps identify whether the DXY breakout has real trend strength. A breakout with ADX above 25 is more reliable than a breakout during a choppy market.

---

## 11. Signal 8: DXY Above Upper Bollinger Band

### Requirement

Detect upside volatility expansion in DXY.

### Formula

```text
Middle Band = SMA_20

Upper Band = SMA_20 + 2 × STD_20

Lower Band = SMA_20 - 2 × STD_20
```

### Signal

```text
DXY_Close > Upper_Band
AND
Bollinger_Band_Width is expanding
```

### Python Logic

```python
sma20 = dxy_close.rolling(20).mean()
std20 = dxy_close.rolling(20).std()

upper_band = sma20 + 2 * std20
lower_band = sma20 - 2 * std20

bb_width = (upper_band - lower_band) / sma20
bb_width_expanding = bb_width > bb_width.shift(5)

bb_breakout = (dxy_close > upper_band) & bb_width_expanding
```

### Why It Matters

A close above the upper Bollinger Band means DXY is rising with volatility expansion. This can be a stronger warning than a simple moving average breakout.

---

## 12. Signal 9: DXY vs SPY Divergence

### Requirement

Check whether DXY is rising while SPY momentum is weakening.

### Basic Signal

```text
DXY_10D_ROC > 0
AND
SPY_10D_ROC < 0
```

### Strong Signal

```text
DXY_20D_ROC > +1.5%
AND
SPY_20D_ROC < 0
```

### Python Logic

```python
dxy_roc20 = dxy_close / dxy_close.shift(20) - 1
spy_roc20 = spy_close / spy_close.shift(20) - 1

dxy_spy_divergence = (dxy_roc20 > 0.015) & (spy_roc20 < 0)
```

### Why It Matters

DXY strength becomes more relevant to equity risk when SPY is already weakening. This avoids overreacting to dollar strength during a still-healthy equity market.

---

## 13. Signal 10: DXY vs HYG Confirmation

### Requirement

Check whether high-yield bonds are confirming dollar stress.

### Basic Signal

```text
DXY_10D_ROC > +1%
AND
HYG_10D_ROC < SPY_10D_ROC
```

### Strong Signal

```text
DXY_10D_ROC > +1%
AND
HYG_Close < HYG_SMA_20
AND
HYG_Close < HYG_SMA_50
```

### Python Logic

```python
hyg_roc10 = hyg_close / hyg_close.shift(10) - 1
spy_roc10 = spy_close / spy_close.shift(10) - 1
dxy_roc10 = dxy_close / dxy_close.shift(10) - 1

hyg_underperforming_spy = hyg_roc10 < spy_roc10

hyg_sma20 = hyg_close.rolling(20).mean()
hyg_sma50 = hyg_close.rolling(50).mean()

hyg_breakdown = (hyg_close < hyg_sma20) & (hyg_close < hyg_sma50)

dxy_hyg_risk_confirmed = (
    (dxy_roc10 > 0.01)
    & hyg_underperforming_spy
    & hyg_breakdown
)
```

### Why It Matters

HYG weakness confirms that credit risk is deteriorating. A DXY breakout together with HYG weakness is much more dangerous for equities than DXY strength alone.

---

## 14. Recommended DXY Equity Risk Score

The script should calculate a score from 0 to 10.

### Scoring Table

| Signal | Points |
|---|---:|
| DXY close above prior 60-day high | +2 |
| DXY close above prior 90-day high | +1 |
| DXY above SMA20 and SMA50 | +1 |
| SMA20 > SMA50 | +1 |
| DXY 10D ROC > +1.0% | +1 |
| DXY 20D ROC > +2.0% | +1 |
| DXY z-score > +1.5 | +1 |
| DXY ATR-adjusted breakout | +1 |
| ADX14 > 25 and +DI > -DI | +1 |
| DXY up while SPY 20D ROC < 0 | +1 |
| DXY up while HYG underperforms SPY over 10D | +1 |

The final score should be capped at 10.

### Python Logic

```python
score = 0

score += 2 if dxy_close > prior_high_60 else 0
score += 1 if dxy_close > prior_high_90 else 0
score += 1 if dxy_close > sma20 and dxy_close > sma50 else 0
score += 1 if sma20 > sma50 else 0
score += 1 if dxy_roc10 > 0.01 else 0
score += 1 if dxy_roc20 > 0.02 else 0
score += 1 if dxy_z > 1.5 else 0
score += 1 if atr_breakout else 0
score += 1 if adx14 > 25 and plus_di > minus_di else 0
score += 1 if dxy_roc20 > 0 and spy_roc20 < 0 else 0
score += 1 if dxy_roc10 > 0.01 and hyg_roc10 < spy_roc10 else 0

score = min(score, 10)
```

---

## 15. Score Interpretation

| Score | Interpretation | Equity Risk Meaning |
|---:|---|---|
| 0–2 | No meaningful DXY breakout | Dollar is not a major equity headwind |
| 3–4 | Early warning | Watch SPY, HYG, and VIX confirmation |
| 5–6 | Confirmed DXY pressure | Avoid chasing aggressive long exposure |
| 7–8 | Strong dollar risk-off setup | Equity upside may be fragile |
| 9–10 | Severe USD breakout stress | High risk of equity drawdown or failed equity breakout |

---

## 16. Minimum Alert Definition

### DXY Breakout Warning

The dashboard should trigger a **DXY Breakout Warning** when:

```text
DXY close > prior 60-day high
AND
DXY close > SMA20
AND
SMA20 > SMA50
AND
DXY 10-day ROC > +1%
```

### DXY Equity Risk Confirmed

The dashboard should trigger **DXY Equity Risk Confirmed** when:

```text
DXY Breakout Warning
AND
(
    SPY 20D ROC < 0
    OR
    HYG 10D ROC < SPY 10D ROC
    OR
    HYG close < HYG SMA20 and HYG close < HYG SMA50
)
```

---

## 17. Output Requirements

The Python script should output the following fields each day:

| Field | Description |
|---|---|
| date | Trading date |
| dxy_close | Latest DXY close |
| dxy_60d_high | Prior 60-day high |
| dxy_90d_high | Prior 90-day high |
| dxy_sma20 | 20-day moving average |
| dxy_sma50 | 50-day moving average |
| dxy_sma200 | 200-day moving average |
| dxy_roc10 | 10-day DXY rate of change |
| dxy_roc20 | 20-day DXY rate of change |
| dxy_zscore_60 | 60-day DXY z-score |
| dxy_atr14 | 14-day ATR |
| dxy_adx14 | 14-day ADX |
| spy_roc20 | 20-day SPY rate of change |
| hyg_roc10 | 10-day HYG rate of change |
| spy_roc10 | 10-day SPY rate of change |
| dxy_breakout_warning | True / False |
| dxy_equity_risk_confirmed | True / False |
| dxy_equity_risk_score | 0 to 10 |
| risk_label | No Risk / Early Warning / Confirmed Pressure / Strong Risk-Off / Severe Stress |

---

## 18. Suggested Risk Label Logic

```python
if score <= 2:
    risk_label = "No meaningful DXY equity risk"
elif score <= 4:
    risk_label = "Early warning"
elif score <= 6:
    risk_label = "Confirmed DXY pressure"
elif score <= 8:
    risk_label = "Strong dollar risk-off setup"
else:
    risk_label = "Severe USD breakout stress"
```

---

## 19. Practical Notes

1. Do not rely on DXY alone.
2. Treat DXY as a macro pressure signal.
3. Confirmation from HYG and SPY makes the signal much more useful.
4. A slow dollar uptrend is less dangerous than a fast dollar breakout.
5. A DXY breakout with HYG breakdown is more important than a DXY breakout while credit remains strong.
6. The score should be reviewed together with other dashboard modules, especially HYG, SPY momentum, and VIX support/breakout conditions.

---

## 20. Final Recommended Implementation

Use two layers:

### Layer 1: Dollar Breakout Detection

```text
DXY close > prior 60-day high
AND
DXY close > SMA20
AND
SMA20 > SMA50
AND
DXY 10D ROC > +1%
```

### Layer 2: Equity Risk Confirmation

```text
Layer 1 is True
AND
(
    SPY 20D ROC < 0
    OR
    HYG 10D ROC < SPY 10D ROC
    OR
    HYG close < SMA20 and SMA50
)
```

This structure separates:

```text
DXY breakout = dollar strength signal

DXY equity risk confirmed = dollar strength is already hurting risk assets
```

---

## 21. New SPY Sub-Signals (Experimental, Added June 2026)

Two additional signals were added to the `$SPY` scoring model after backtesting five years of daily data (August 2021 – May 2026). Both target predicting a ≥5% SPY close drop within the next 20 trading days, optimised for F2 score (β=2, recall weighted 2× over precision).

---

### 21.1 SPY Intraday Reversal

#### Motivation

The June 3, 2026 case study showed that intraday distribution (market rallied but gave back most gains before close) is not captured by close-only scoring. A session where the S&P 500 makes a significant intraday high but closes near the low suggests sellers are active and buyers are not sustaining bids — a classic distribution pattern preceding a trend reversal.

#### Signal Definition

```text
SPY_Intraday_Rev_Ratio = (SPY_High_today - SPY_Close_today) / ATR14

Signal fires when: SPY_Intraday_Rev_Ratio ≥ 1.0
```

The ratio measures how much of the daily high-to-close range was given back, expressed as a multiple of the 14-day Average True Range. A value ≥ 1.0 means the close-to-high gap exceeds a full ATR — sellers dominated the session.

#### Python Logic

```python
highs  = [x[1] for x in spy_ohlc]
lows   = [x[2] for x in spy_ohlc]
closes = [x[3] for x in spy_ohlc]
atr14  = calc_atr14(highs, lows, closes)

intraday_rev_ratio = (highs[-1] - closes[-1]) / atr14
signal_intraday_reversal = intraday_rev_ratio >= 1.0
```

#### Score Contribution

| Signal | Points |
|--------|-------:|
| SPY intraday reversal ≥ 1.0 × ATR14 | +1 |

#### Backtest Results (5Y, target ≥5% drop in 20 days)

| Metric | Value |
|--------|-------|
| Threshold | ≥ 1.0 × ATR14 |
| Fire rate | ~9% of trading days |
| True positive rate (recall) | 0.121 |
| Precision | **0.250** (vs 0.196 base rate) |
| F2 score | 0.135 |
| Characteristic | High-confidence, low-frequency flag |

Precision of 0.250 is the highest of all candidate signals tested, making this a reliable confirmation signal when it fires. Its low recall (12%) means it should be used alongside other signals, not as a standalone trigger.

#### Data Requirement

Requires SPY OHLC (high, low, close) over at least 15 trading days. Fetched automatically via Yahoo Finance in `yf-api` mode. In `browser-json` mode, include `"high"` and `"low"` fields in SPY rows; if absent, the signal is silently skipped.

---

### 21.2 IWM/SPY Breadth Divergence

#### Motivation

The June 3, 2026 case study showed that the Russell 2000 (IWM) fell -1.25% vs the S&P 500 (SPY) -0.74% — a 51 basis point underperformance. Small-cap underperformance relative to large-cap is a classic early risk-off rotation signal: when institutional investors reduce risk, they sell higher-beta small caps first while large-cap mega-stocks provide temporary cover for headline indices.

#### Signal Definition

```text
IWM_SPY_Spread_5d = (IWM_5d_ROC - SPY_5d_ROC) × 100   (in percentage points)

Signal fires when: IWM_SPY_Spread_5d < -0.5
```

The spread is computed as the difference in 5-day percentage returns between IWM and SPY. A negative value means IWM underperformed SPY over the past 5 trading days.

#### Python Logic

```python
iwm_roc5 = (iwm_closes[-1] / iwm_closes[-6]) - 1
spy_roc5 = (spy_closes[-1] / spy_closes[-6]) - 1

iwm_spy_spread_5d = (iwm_roc5 - spy_roc5) * 100   # percentage points
signal_breadth_divergence = iwm_spy_spread_5d < -0.5
```

#### Score Contribution

| Signal | Points |
|--------|-------:|
| IWM 5d ROC < SPY 5d ROC − 0.5pp | +1 |

#### Backtest Results (5Y, target ≥5% drop in 20 days)

| Metric | Value |
|--------|-------|
| Threshold | IWM lags SPY by > 0.5 percentage points over 5 days |
| Fire rate | ~41% of trading days |
| True positive rate (recall) | 0.418 |
| Precision | 0.198 |
| F2 score | 0.342 |
| Characteristic | Best recall of new signals; use as composite vote |

The signal fires frequently (~41% of days) with moderate recall. Its primary value is as a composite confirmation input — when IWM breadth deterioration coincides with HYG weakness or VIX elevation, the combined signal is more reliable than any component alone.

#### Data Requirement

Requires IWM close data over at least 6 trading days. Fetched automatically via Yahoo Finance in `yf-api` mode. In `browser-json` mode, include an `"IWM"` key with close-only rows; if absent, the signal is silently skipped.

---

### 21.3 Signals Not Promoted

The following candidates were tested at the same time but not added to the scoring model:

| Candidate | Best F2 | Reason not promoted |
|-----------|---------|---------------------|
| TLT 5d ROC > 1% | 0.205 | Low precision (0.163); flight-to-safety bid has many non-risk-off causes |
| VIX/SPY 10d correlation > −0.4 | 0.050 | Weak in isolation; VIX score already includes a correlation breakdown signal |
| VIX9D/VIX ratio | n/a | ^VXST (CBOE 9-day VIX) unavailable on Yahoo Finance; test deferred |

The VIX9D/VIX ratio (near-term vol backwardation) remains a priority candidate for future testing once a reliable data source is identified. A ratio below 0.90 (spot VIX elevated relative to 9-day implied) is a well-known term structure stress indicator.
