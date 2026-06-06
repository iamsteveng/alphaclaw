#!/usr/bin/env python3
"""
Backtest new candidate signals for predicting SPY >5% drop within next 20 trading days.

Signals tested:
  1. IWM/SPY 5d return spread  (IWM underperforms SPY → small-cap breadth deterioration)
  2. VIX9D/VIX ratio           (^VXST / ^VIX < threshold → near-term vol backwardation)
  3. TLT ROC5                  (TLT 5d return > threshold → flight-to-safety bid)
  4. SPY intraday reversal     ((High - Close) / ATR14 > threshold → sold the rally)
  5. VIX/SPY 10d corr          (rolling corr > threshold → correlation breakdown, already
                                 in system but tested here for optimal weight/threshold)

Label: min(SPY_close[t+1 .. t+20]) / SPY_close[t] - 1  <  -0.05
       i.e., SPY drops >5% from today's close at ANY point in the next 20 trading days.

Metrics:
  TPR (recall)  = TP / (TP + FN)   — fraction of actual drops we caught
  Precision     = TP / (TP + FP)
  F2            = 5 * P * R / (4*P + R)   — β=2 weights recall 2× over precision

Threshold optimisation: each signal is swept across a grid; the threshold with best F2
is selected and reported.

Data: Yahoo Finance public JSON API, 5-year daily (range=5y).
Tickers: SPY (OHLC), IWM, TLT, ^VIX, ^VXST
"""

import json
import sys
import math
import urllib.request
import urllib.error
import urllib.parse
import datetime
from collections import defaultdict

# ---------------------------------------------------------------------------
# Data fetching — Yahoo Finance public API
# ---------------------------------------------------------------------------

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; backtest/1.0)",
    "Accept": "application/json",
}


def _fetch_yf(symbol: str, range_str: str = "5y") -> dict:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol, safe='')}?range={range_str}&interval=1d&includePrePost=false"
    )
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def fetch_ohlc(symbol: str) -> dict:
    """Returns {date: (open, high, low, close)} sorted ascending."""
    data = _fetch_yf(symbol)
    result = data["chart"]["result"][0]
    timestamps = result["timestamp"]
    q = result["indicators"]["quote"][0]
    opens  = q.get("open",  [None] * len(timestamps))
    highs  = q.get("high",  [None] * len(timestamps))
    lows   = q.get("low",   [None] * len(timestamps))
    closes = q.get("close", [None] * len(timestamps))
    rows = {}
    for ts, o, h, l, c in zip(timestamps, opens, highs, lows, closes):
        if None in (h, l, c):
            continue
        d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date()
        rows[d] = (float(o) if o else float(c), float(h), float(l), float(c))
    return rows


def fetch_close(symbol: str) -> dict:
    """Returns {date: close_price}."""
    data = _fetch_yf(symbol)
    result = data["chart"]["result"][0]
    timestamps = result["timestamp"]
    closes = result["indicators"]["quote"][0].get("close", [])
    rows = {}
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date()
        rows[d] = float(c)
    return rows


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def sorted_dates(d: dict):
    return sorted(d.keys())


def atr14(ohlc_map: dict, dates: list, i: int) -> float | None:
    if i < 14:
        return None
    trs = []
    for j in range(i - 13, i + 1):
        d = dates[j]
        _, h, l, c = ohlc_map[d]
        prev_c = ohlc_map[dates[j - 1]][3]
        trs.append(max(h - l, abs(h - prev_c), abs(l - prev_c)))
    return sum(trs) / 14


def rolling_pearson(x_series: list, y_series: list, n: int = 10) -> float | None:
    if len(x_series) < n + 1 or len(y_series) < n + 1:
        return None
    dx = [(x_series[i] - x_series[i-1]) / x_series[i-1]
          for i in range(len(x_series)-n, len(x_series)) if x_series[i-1] != 0]
    dy = [(y_series[i] - y_series[i-1]) / y_series[i-1]
          for i in range(len(y_series)-n, len(y_series)) if y_series[i-1] != 0]
    if len(dx) < 3 or len(dx) != len(dy):
        return None
    n2 = len(dx)
    mx, my = sum(dx)/n2, sum(dy)/n2
    cov = sum((dx[i]-mx)*(dy[i]-my) for i in range(n2)) / n2
    sx = (sum((v-mx)**2 for v in dx)/n2)**0.5
    sy = (sum((v-my)**2 for v in dy)/n2)**0.5
    return cov / (sx * sy) if sx and sy else None


def f2(precision: float, recall: float) -> float:
    if precision + recall == 0:
        return 0.0
    return 5 * precision * recall / (4 * precision + recall)


def metrics(tp, fp, fn, tn):
    recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    f2_score  = f2(precision, recall)
    return recall, precision, f2_score


# ---------------------------------------------------------------------------
# Threshold sweep
# ---------------------------------------------------------------------------

def best_threshold(pairs: list, thresholds: list, direction: str = "above") -> tuple:
    """
    pairs: [(signal_value, label_bool), ...]
    direction: 'above' → signal fires when value > threshold
               'below' → signal fires when value < threshold
    Returns (best_threshold, tpr, precision, f2, tp, fp, fn, tn)
    """
    best = None
    for thr in thresholds:
        tp = fp = fn = tn = 0
        for val, lbl in pairs:
            if val is None:
                continue
            fired = (val > thr) if direction == "above" else (val < thr)
            if fired and lbl:   tp += 1
            elif fired:         fp += 1
            elif lbl:           fn += 1
            else:               tn += 1
        r, p, f = metrics(tp, fp, fn, tn)
        if best is None or f > best[3]:
            best = (thr, r, p, f, tp, fp, fn, tn)
    return best or (None, 0, 0, 0, 0, 0, 0, 0)


# ---------------------------------------------------------------------------
# Main backtest
# ---------------------------------------------------------------------------

def main():
    print("Fetching 5 years of daily data...", flush=True)

    try:
        spy_ohlc = fetch_ohlc("SPY")
        print(f"  SPY OHLC:  {len(spy_ohlc)} days")
    except Exception as e:
        print(f"ERROR fetching SPY: {e}"); sys.exit(1)

    imw_closes = {}
    try:
        imw_closes = fetch_close("IWM")
        print(f"  IWM close: {len(imw_closes)} days")
    except Exception as e:
        print(f"  WARNING IWM: {e}")

    tlt_closes = {}
    try:
        tlt_closes = fetch_close("TLT")
        print(f"  TLT close: {len(tlt_closes)} days")
    except Exception as e:
        print(f"  WARNING TLT: {e}")

    vix_closes = {}
    try:
        vix_closes = fetch_close("^VIX")
        print(f"  ^VIX close:{len(vix_closes)} days")
    except Exception as e:
        print(f"  WARNING VIX: {e}")

    vxst_closes = {}
    try:
        vxst_closes = fetch_close("^VXST")
        print(f"  ^VXST close:{len(vxst_closes)} days")
    except Exception as e:
        print(f"  WARNING ^VXST (VIX9D): {e}")

    # Common trading dates (SPY is the base)
    spy_dates = sorted_dates(spy_ohlc)
    spy_close_map = {d: spy_ohlc[d][3] for d in spy_dates}

    # Build label: 1 if SPY drops >5% within next 20 trading days
    labels = {}
    for i, d in enumerate(spy_dates):
        future = spy_dates[i+1 : i+21]
        if len(future) < 20:
            labels[d] = None   # not enough future data
            continue
        base = spy_close_map[d]
        worst = min(spy_close_map[f] for f in future)
        labels[d] = (worst / base - 1) < -0.05

    # Drop last 20 days (no label) and first ~50 warmup days
    valid_dates = [d for d in spy_dates[50:] if labels.get(d) is not None]

    total = len(valid_dates)
    pos   = sum(1 for d in valid_dates if labels[d])
    neg   = total - pos
    base_rate = pos / total if total > 0 else 0

    print(f"\nDataset: {valid_dates[0]} → {valid_dates[-1]}")
    print(f"  Total days: {total} | Positives (>5% drop): {pos} ({base_rate:.1%}) | Negatives: {neg}")

    # ------------------------------------------------------------------
    # Pre-compute signal values for every valid date
    # ------------------------------------------------------------------
    spy_idx = {d: i for i, d in enumerate(spy_dates)}

    sig1_pairs = []   # IWM/SPY 5d spread
    sig2_pairs = []   # VIX9D/VIX ratio
    sig3_pairs = []   # TLT ROC5
    sig4_pairs = []   # SPY intraday reversal (High-Close)/ATR14
    sig5_pairs = []   # VIX/SPY rolling 10d corr

    for d in valid_dates:
        i = spy_idx[d]
        lbl = labels[d]

        # ---- Signal 1: IWM/SPY 5d return spread ----
        val1 = None
        if d in imw_closes and i >= 5:
            d5 = spy_dates[i-5]
            if d5 in imw_closes and spy_close_map[d5] and imw_closes[d5]:
                iwm_r5 = imw_closes[d] / imw_closes[d5] - 1
                spy_r5 = spy_close_map[d] / spy_close_map[d5] - 1
                val1 = (iwm_r5 - spy_r5) * 100  # percentage points; negative = IWM lags
        sig1_pairs.append((val1, lbl))

        # ---- Signal 2: VIX9D / VIX ratio ----
        val2 = None
        if d in vxst_closes and d in vix_closes and vix_closes[d]:
            val2 = vxst_closes[d] / vix_closes[d]
        sig2_pairs.append((val2, lbl))

        # ---- Signal 3: TLT 5d ROC ----
        val3 = None
        if d in tlt_closes and i >= 5:
            d5 = spy_dates[i-5]
            if d5 in tlt_closes and tlt_closes[d5]:
                val3 = (tlt_closes[d] / tlt_closes[d5] - 1) * 100
        sig3_pairs.append((val3, lbl))

        # ---- Signal 4: SPY (High - Close) / ATR14 ----
        val4 = None
        atr = atr14(spy_ohlc, spy_dates, i)
        if atr and atr > 0:
            _, h, _, c = spy_ohlc[d]
            val4 = (h - c) / atr
        sig4_pairs.append((val4, lbl))

        # ---- Signal 5: VIX/SPY rolling 10d correlation ----
        val5 = None
        if i >= 11:
            vix_window = [vix_closes[spy_dates[j]] for j in range(i-10, i+1)
                          if spy_dates[j] in vix_closes]
            spy_window = [spy_close_map[spy_dates[j]] for j in range(i-10, i+1)]
            if len(vix_window) == 11 and len(spy_window) == 11:
                val5 = rolling_pearson(vix_window, spy_window, 10)
        sig5_pairs.append((val5, lbl))

    # ------------------------------------------------------------------
    # Threshold sweeps
    # ------------------------------------------------------------------

    # Signal 1: fires when spread < threshold (IWM underperforms)
    # negative = IWM lagging; more negative = more risk-off rotation
    s1_vals = [v for v, _ in sig1_pairs if v is not None]
    if s1_vals:
        s1_min, s1_max = min(s1_vals), max(s1_vals)
        s1_grid = [s1_min + (s1_max - s1_min) * k / 40 for k in range(41)]
    else:
        s1_grid = []

    # Signal 2: fires when ratio < threshold (near-term vol elevated vs 30d)
    s2_vals = [v for v, _ in sig2_pairs if v is not None]
    if s2_vals:
        s2_min, s2_max = min(s2_vals), max(s2_vals)
        s2_grid = [s2_min + (s2_max - s2_min) * k / 40 for k in range(41)]
    else:
        s2_grid = []

    # Signal 3: fires when TLT ROC5 > threshold (flight to safety)
    s3_vals = [v for v, _ in sig3_pairs if v is not None]
    if s3_vals:
        s3_min, s3_max = min(s3_vals), max(s3_vals)
        s3_grid = [s3_min + (s3_max - s3_min) * k / 40 for k in range(41)]
    else:
        s3_grid = []

    # Signal 4: fires when (High-Close)/ATR > threshold (intraday reversal)
    s4_vals = [v for v, _ in sig4_pairs if v is not None]
    if s4_vals:
        s4_min, s4_max = min(s4_vals), max(s4_vals)
        s4_grid = [s4_min + (s4_max - s4_min) * k / 40 for k in range(41)]
    else:
        s4_grid = []

    # Signal 5: fires when corr > threshold (breakdown, less negative than normal)
    s5_vals = [v for v, _ in sig5_pairs if v is not None]
    if s5_vals:
        s5_min, s5_max = min(s5_vals), max(s5_vals)
        s5_grid = [s5_min + (s5_max - s5_min) * k / 40 for k in range(41)]
    else:
        s5_grid = []

    results = []

    if s1_grid:
        thr, tpr, prec, f2s, tp, fp, fn, tn = best_threshold(sig1_pairs, s1_grid, "below")
        n_valid = sum(1 for v, _ in sig1_pairs if v is not None)
        results.append(("IWM/SPY 5d spread",      "< thr (IWM lags)", thr, tpr, prec, f2s, tp, fp, fn, tn, n_valid))

    if s2_grid:
        thr, tpr, prec, f2s, tp, fp, fn, tn = best_threshold(sig2_pairs, s2_grid, "below")
        n_valid = sum(1 for v, _ in sig2_pairs if v is not None)
        results.append(("VIX9D/VIX ratio",         "< thr (backwardation)", thr, tpr, prec, f2s, tp, fp, fn, tn, n_valid))

    if s3_grid:
        thr, tpr, prec, f2s, tp, fp, fn, tn = best_threshold(sig3_pairs, s3_grid, "above")
        n_valid = sum(1 for v, _ in sig3_pairs if v is not None)
        results.append(("TLT 5d ROC",              "> thr% (safety bid)", thr, tpr, prec, f2s, tp, fp, fn, tn, n_valid))

    if s4_grid:
        thr, tpr, prec, f2s, tp, fp, fn, tn = best_threshold(sig4_pairs, s4_grid, "above")
        n_valid = sum(1 for v, _ in sig4_pairs if v is not None)
        results.append(("SPY intraday reversal",   "> thr×ATR", thr, tpr, prec, f2s, tp, fp, fn, tn, n_valid))

    if s5_grid:
        thr, tpr, prec, f2s, tp, fp, fn, tn = best_threshold(sig5_pairs, s5_grid, "above")
        n_valid = sum(1 for v, _ in sig5_pairs if v is not None)
        results.append(("VIX/SPY 10d corr",        "> thr (corr breakdown)", thr, tpr, prec, f2s, tp, fp, fn, tn, n_valid))

    # ------------------------------------------------------------------
    # Baseline: always-off and always-on
    # ------------------------------------------------------------------
    print(f"\n{'='*80}")
    print(f"BACKTEST RESULTS — Predict SPY >5% drop within 20 trading days")
    print(f"{'='*80}")
    print(f"Base rate: {pos}/{total} days = {base_rate:.1%}  (fraction of days followed by a >5% drop)\n")
    print(f"  Always-fire baseline:  TPR=1.000  Prec={base_rate:.3f}  F2={f2(base_rate, 1.0):.3f}")
    print(f"  Never-fire baseline:   TPR=0.000  Prec=N/A        F2=0.000\n")

    print(f"{'Signal':<28} {'Condition':<26} {'Threshold':>10} {'TPR':>7} {'Prec':>7} {'F2':>7} {'TP':>5} {'FP':>5} {'FN':>5} {'TN':>5} {'Fire%':>6} {'N':>5}")
    print(f"{'-'*28} {'-'*26} {'-'*10} {'-'*7} {'-'*7} {'-'*7} {'-'*5} {'-'*5} {'-'*5} {'-'*5} {'-'*6} {'-'*5}")

    for (name, cond, thr, tpr, prec, f2s, tp, fp, fn, tn, n_valid) in results:
        fire_rate = (tp + fp) / n_valid if n_valid else 0
        thr_fmt = f"{thr:+.3f}" if isinstance(thr, float) else str(thr)
        print(f"{name:<28} {cond:<26} {thr_fmt:>10} {tpr:>7.3f} {prec:>7.3f} {f2s:>7.3f} {tp:>5} {fp:>5} {fn:>5} {tn:>5} {fire_rate:>6.1%} {n_valid:>5}")

    # ------------------------------------------------------------------
    # Also show a few alternative thresholds per signal for context
    # ------------------------------------------------------------------
    print(f"\n{'='*80}")
    print("THRESHOLD SENSITIVITY (F2 at common practical thresholds)")
    print(f"{'='*80}")

    # Signal 1 at fixed practical thresholds
    if s1_grid:
        print("\nSignal 1 — IWM/SPY 5d spread < X pct-pts (IWM underperforms SPY by X%)")
        print(f"  {'Threshold':>10} {'TPR':>7} {'Prec':>7} {'F2':>7} {'Fire%':>7}")
        for thr in [-0.5, -1.0, -1.5, -2.0, -3.0]:
            tp=fp=fn=tn=0
            for val, lbl in sig1_pairs:
                if val is None: continue
                fired = val < thr
                if fired and lbl: tp+=1
                elif fired:       fp+=1
                elif lbl:         fn+=1
                else:             tn+=1
            r, p, f = metrics(tp, fp, fn, tn)
            n_valid = tp+fp+fn+tn
            print(f"  {thr:>10.1f} {r:>7.3f} {p:>7.3f} {f:>7.3f} {(tp+fp)/n_valid if n_valid else 0:>7.1%}")

    if s2_grid:
        print("\nSignal 2 — VIX9D/VIX ratio < X (spot VIX > 9d VIX by factor)")
        print(f"  {'Threshold':>10} {'TPR':>7} {'Prec':>7} {'F2':>7} {'Fire%':>7}")
        for thr in [0.80, 0.85, 0.90, 0.95, 1.00]:
            tp=fp=fn=tn=0
            for val, lbl in sig2_pairs:
                if val is None: continue
                fired = val < thr
                if fired and lbl: tp+=1
                elif fired:       fp+=1
                elif lbl:         fn+=1
                else:             tn+=1
            r, p, f = metrics(tp, fp, fn, tn)
            n_valid = tp+fp+fn+tn
            print(f"  {thr:>10.2f} {r:>7.3f} {p:>7.3f} {f:>7.3f} {(tp+fp)/n_valid if n_valid else 0:>7.1%}")

    if s3_grid:
        print("\nSignal 3 — TLT 5d ROC > X% (flight-to-safety bid)")
        print(f"  {'Threshold':>10} {'TPR':>7} {'Prec':>7} {'F2':>7} {'Fire%':>7}")
        for thr in [0.0, 0.5, 1.0, 1.5, 2.0]:
            tp=fp=fn=tn=0
            for val, lbl in sig3_pairs:
                if val is None: continue
                fired = val > thr
                if fired and lbl: tp+=1
                elif fired:       fp+=1
                elif lbl:         fn+=1
                else:             tn+=1
            r, p, f = metrics(tp, fp, fn, tn)
            n_valid = tp+fp+fn+tn
            print(f"  {thr:>10.1f} {r:>7.3f} {p:>7.3f} {f:>7.3f} {(tp+fp)/n_valid if n_valid else 0:>7.1%}")

    if s4_grid:
        print("\nSignal 4 — SPY (High-Close)/ATR14 > X (intraday reversal magnitude)")
        print(f"  {'Threshold':>10} {'TPR':>7} {'Prec':>7} {'F2':>7} {'Fire%':>7}")
        for thr in [0.3, 0.5, 0.7, 1.0, 1.5]:
            tp=fp=fn=tn=0
            for val, lbl in sig4_pairs:
                if val is None: continue
                fired = val > thr
                if fired and lbl: tp+=1
                elif fired:       fp+=1
                elif lbl:         fn+=1
                else:             tn+=1
            r, p, f = metrics(tp, fp, fn, tn)
            n_valid = tp+fp+fn+tn
            print(f"  {thr:>10.1f} {r:>7.3f} {p:>7.3f} {f:>7.3f} {(tp+fp)/n_valid if n_valid else 0:>7.1%}")

    if s5_grid:
        print("\nSignal 5 — VIX/SPY 10d rolling corr > X (breakdown from normal ≈ -0.8)")
        print(f"  {'Threshold':>10} {'TPR':>7} {'Prec':>7} {'F2':>7} {'Fire%':>7}")
        for thr in [-0.6, -0.4, -0.2, 0.0, 0.2]:
            tp=fp=fn=tn=0
            for val, lbl in sig5_pairs:
                if val is None: continue
                fired = val > thr
                if fired and lbl: tp+=1
                elif fired:       fp+=1
                elif lbl:         fn+=1
                else:             tn+=1
            r, p, f = metrics(tp, fp, fn, tn)
            n_valid = tp+fp+fn+tn
            print(f"  {thr:>10.1f} {r:>7.3f} {p:>7.3f} {f:>7.3f} {(tp+fp)/n_valid if n_valid else 0:>7.1%}")

    # ------------------------------------------------------------------
    # Combo: any 2+ signals fire simultaneously
    # ------------------------------------------------------------------
    print(f"\n{'='*80}")
    print("COMBINATION SIGNAL — fires when 2+ individual signals fire at their optimal thresholds")
    print(f"{'='*80}")

    # Collect optimal thresholds from results
    opt_thresholds = {r[0]: (r[2], r[1]) for r in results}  # name -> (thr, direction_condition)
    sig_name_map = {
        "IWM/SPY 5d spread":    ("below", sig1_pairs),
        "VIX9D/VIX ratio":      ("below", sig2_pairs),
        "TLT 5d ROC":           ("above", sig3_pairs),
        "SPY intraday reversal":("above", sig4_pairs),
        "VIX/SPY 10d corr":     ("above", sig5_pairs),
    }

    # Build per-date signal vector
    date_sigs = defaultdict(dict)
    for name, (direction, pairs) in sig_name_map.items():
        if name not in opt_thresholds:
            continue
        thr, _ = opt_thresholds[name]
        for (val, lbl), d in zip(pairs, valid_dates):
            if val is None:
                date_sigs[d][name] = None
            else:
                date_sigs[d][name] = (val > thr) if direction == "above" else (val < thr)

    for min_count in [1, 2, 3]:
        tp=fp=fn=tn=0
        for i, d in enumerate(valid_dates):
            fires_this_day = sum(1 for v in date_sigs[d].values() if v is True)
            lbl = labels[d]
            fired = fires_this_day >= min_count
            if fired and lbl: tp+=1
            elif fired:       fp+=1
            elif lbl:         fn+=1
            else:             tn+=1
        r, p, f = metrics(tp, fp, fn, tn)
        n_valid = tp+fp+fn+tn
        available_sigs = sum(1 for r in results)
        print(f"  ≥{min_count}/{available_sigs} signals fire:  TPR={r:.3f}  Prec={p:.3f}  F2={f:.3f}  "
              f"Fire%={(tp+fp)/n_valid if n_valid else 0:.1%}  TP={tp}  FP={fp}  FN={fn}  TN={tn}")


if __name__ == "__main__":
    main()
