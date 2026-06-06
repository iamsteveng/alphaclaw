#!/usr/bin/env python3
"""
Market Risk Score — Backtesting Harness

Walk-forward backtest of the DXY / HYG / SPY / VIX composite scoring model.
Measures true-positive rate (TPR), false-positive rate (FPR), precision, and F1
for predicting ≥5% SPY drawdowns within the next 14 trading days.

Usage:
  python3 backtest_market_risk_score.py
  python3 backtest_market_risk_score.py --years 10 --drop-pct 7
  python3 backtest_market_risk_score.py --window 10
  python3 backtest_market_risk_score.py --csv results.csv
"""
import argparse
import csv
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from market_risk_score import (
    compute_dxy_score,
    compute_hyg_score,
    compute_spy_score,
    compute_vix_score,
)


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def _yf_fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; market-risk-backtest/1.0)",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"Network error: {e}")


def _yf_url(symbol, years):
    return (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.parse.quote(symbol, safe='')}?range={years}y&interval=1d&includePrePost=false"
    )


def fetch_close_history(symbol, years):
    data = _yf_fetch(_yf_url(symbol, years))
    result = (data.get("chart", {}).get("result") or [])
    if not result:
        raise RuntimeError(f"No data for {symbol}: {data.get('chart', {}).get('error')}")
    quotes = result[0].get("indicators", {}).get("quote", [{}])
    timestamps = result[0].get("timestamp", [])
    closes = quotes[0].get("close", [])
    pairs = []
    for ts, c in zip(timestamps, closes):
        if c is None:
            continue
        d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date()
        pairs.append((d, float(c)))
    pairs.sort(key=lambda x: x[0])
    return pairs


def fetch_ohlc_history(symbol, years):
    data = _yf_fetch(_yf_url(symbol, years))
    result = (data.get("chart", {}).get("result") or [])
    if not result:
        raise RuntimeError(f"No data for {symbol}: {data.get('chart', {}).get('error')}")
    quotes = result[0].get("indicators", {}).get("quote", [{}])
    timestamps = result[0].get("timestamp", [])
    highs  = quotes[0].get("high",  [])
    lows   = quotes[0].get("low",   [])
    closes = quotes[0].get("close", [])
    rows = []
    for ts, h, l, c in zip(timestamps, highs, lows, closes):
        if h is None or l is None or c is None:
            continue
        d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date()
        rows.append((d, float(h), float(l), float(c)))
    rows.sort(key=lambda x: x[0])
    return rows


# ---------------------------------------------------------------------------
# Alignment helpers — forward-fill missing dates to SPY calendar
# ---------------------------------------------------------------------------

def align_close(pairs, date_index):
    """Align (date, close) pairs to date_index via forward-fill. Returns list of float|None."""
    data_map = {d: v for d, v in pairs}
    result, last = [], None
    for d in date_index:
        if d in data_map:
            last = data_map[d]
        result.append(last)
    return result


def align_ohlc(rows, date_index):
    """Align (date,h,l,c) rows to date_index via forward-fill. Returns list of tuple|None."""
    data_map = {r[0]: r for r in rows}
    result, last = [], None
    for d in date_index:
        if d in data_map:
            last = data_map[d]
        result.append(last)
    return result


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def metrics(y_true, y_pred, beta=1.0):
    tp = sum(1 for a, p in zip(y_true, y_pred) if a and p)
    fp = sum(1 for a, p in zip(y_true, y_pred) if not a and p)
    tn = sum(1 for a, p in zip(y_true, y_pred) if not a and not p)
    fn = sum(1 for a, p in zip(y_true, y_pred) if a and not p)
    tpr  = tp / (tp + fn)  if (tp + fn) > 0 else 0.0
    fpr  = fp / (fp + tn)  if (fp + tn) > 0 else 0.0
    prec = tp / (tp + fp)  if (tp + fp) > 0 else 0.0
    b2   = beta ** 2
    f1   = 2      * prec * tpr / (prec + tpr)            if (prec + tpr) > 0 else 0.0
    fb   = (1+b2) * prec * tpr / (b2 * prec + tpr)       if (b2 * prec + tpr) > 0 else 0.0
    return {"tp": tp, "fp": fp, "tn": tn, "fn": fn,
            "tpr": tpr, "fpr": fpr, "prec": prec, "f1": f1, "f2": fb}


def mean_std(vals):
    if not vals:
        return 0.0, 0.0
    m = sum(vals) / len(vals)
    s = (sum((v - m) ** 2 for v in vals) / len(vals)) ** 0.5
    return m, s


# ---------------------------------------------------------------------------
# Backtest
# ---------------------------------------------------------------------------

_DXY_LOOKBACK = 210
_SPY_LOOKBACK = 220   # extra buffer for SMA200 + slope calcs
_SHORT_WINDOW = 63    # HYG / VIX lookback
_DXY_MIN      = 210
_HYG_MIN      = 20
_VIX_MIN      = 15


def run_backtest(years=5, drop_pct=0.05, fwd_window=14, csv_path=None):
    fetch_years = years + 1   # extra year to warm up SMA200

    print(f"Fetching {fetch_years}Y history for SPY, IWM, HYG, VIX, DXY...", end=" ", flush=True)
    try:
        spy_raw  = fetch_close_history("SPY",      fetch_years)
        spy_ohlc_raw = fetch_ohlc_history("SPY",   fetch_years)
        iwm_raw  = fetch_close_history("IWM",      years)
        hyg_raw  = fetch_close_history("HYG",      years)
        vix_raw  = fetch_close_history("^VIX",     years)
        dxy_raw  = fetch_ohlc_history ("DX-Y.NYB", fetch_years)
    except RuntimeError as e:
        print(f"\nError: {e}", file=sys.stderr)
        sys.exit(1)
    print("done")

    # Master date index = SPY trading days
    spy_dates   = [r[0] for r in spy_raw]
    spy_closes  = [r[1] for r in spy_raw]

    hyg_aligned      = align_close(hyg_raw,      spy_dates)
    vix_aligned      = align_close(vix_raw,      spy_dates)
    dxy_aligned      = align_ohlc (dxy_raw,      spy_dates)
    spy_ohlc_aligned = align_ohlc (spy_ohlc_raw, spy_dates)
    iwm_aligned      = align_close(iwm_raw,      spy_dates)

    print(f"Walk-forward evaluation ({len(spy_dates):,} total trading days)...", end=" ", flush=True)

    results = []
    for i in range(_SPY_LOOKBACK, len(spy_dates) - fwd_window):
        # --- Build windows ---
        spy_window = spy_closes[:i + 1]          # full history (for SMA200)
        spy_short  = spy_window[-_SHORT_WINDOW:]  # 63-day window for cross-asset signals

        hyg_window = [v for v in hyg_aligned[:i + 1] if v is not None]
        vix_window = [v for v in vix_aligned[:i + 1] if v is not None]
        dxy_window = [r for r in dxy_aligned[:i + 1] if r is not None]

        # align_close/align_ohlc forward-fill from the first available date, so
        # None only appears before the ticker's first trading day.  Taking the
        # tail after stripping those leading Nones preserves SPY-calendar alignment
        # for the 5-day ROC spread and ATR14 lookbacks.
        spy_ohlc_window = [r for r in spy_ohlc_aligned[:i + 1] if r is not None]
        iwm_window      = [v for v in iwm_aligned[:i + 1]      if v is not None]

        hyg_short  = hyg_window[-_SHORT_WINDOW:]
        vix_short  = vix_window[-_SHORT_WINDOW:]

        if len(dxy_window) < _DXY_MIN or len(hyg_short) < _HYG_MIN or len(vix_short) < _VIX_MIN:
            continue

        # --- Compute scores ---
        try:
            dxy_r = compute_dxy_score(dxy_window[-_DXY_MIN:], spy_short, hyg_short)
            hyg_r = compute_hyg_score(hyg_short, spy_short)
            spy_r = compute_spy_score(
                spy_window,
                spy_ohlc=spy_ohlc_window[-30:] if len(spy_ohlc_window) >= 15 else None,
                iwm_closes=iwm_window[-_SHORT_WINDOW:] if len(iwm_window) > 5 else None,
            )
            vix_r = compute_vix_score(vix_short, spy_short)
        except Exception:
            continue

        # --- Label: SPY drops ≥ drop_pct within fwd_window trading days ---
        spy_t      = spy_closes[i]
        spy_future = spy_closes[i + 1: i + 1 + fwd_window]
        if not spy_future:
            continue
        drawdown = (min(spy_future) - spy_t) / spy_t
        label    = drawdown <= -drop_pct

        dxy_b = bool(dxy_r.get("bearish"))
        hyg_b = bool(hyg_r.get("bearish"))
        spy_b = bool(spy_r.get("bearish"))
        vix_b = bool(vix_r.get("bearish"))

        results.append({
            "date":              str(spy_dates[i]),
            "dxy_score":         dxy_r.get("dxy_equity_risk_score") or 0,
            "hyg_score":         hyg_r.get("hyg_risk_score") or 0,
            "spy_score":         spy_r.get("spy_risk_score") or 0,
            "vix_score":         vix_r.get("vix_risk_score") or 0,
            "dxy_bearish":       dxy_b,
            "hyg_bearish":       hyg_b,
            "spy_bearish":       spy_b,
            "vix_bearish":       vix_b,
            "spy_intraday_rev":  spy_r.get("spy_intraday_rev_ratio"),
            "spy_breadth_spread":spy_r.get("iwm_spy_spread_5d"),
            "composite":         int(dxy_b) + int(hyg_b) + int(spy_b) + int(vix_b),
            "label":             label,
            "fwd_drawdown":      round(drawdown * 100, 2),
        })

    print(f"done ({len(results):,} evaluation days)\n")

    if not results:
        print("No results — check data availability.")
        return

    # -----------------------------------------------------------------------
    # Header
    # -----------------------------------------------------------------------
    n     = len(results)
    n_pos = sum(1 for r in results if r["label"])
    base  = n_pos / n
    start = results[0]["date"]
    end   = results[-1]["date"]

    W = 70
    print("=" * W)
    print(f"  Market Risk Score Backtest   {start}  →  {end}")
    print(f"  Target : SPY drops ≥{drop_pct*100:.0f}% within {fwd_window} trading days")
    print(f"  Days   : {n:,}   Positive labels: {n_pos:,} ({base:.1%} base rate)")
    print("=" * W)

    y_true = [r["label"] for r in results]

    # -----------------------------------------------------------------------
    # Composite thresholds
    # -----------------------------------------------------------------------
    print()
    print("Composite (how many of the 4 factors are bearish)")
    print("-" * W)
    print(f"  {'Thresh':<8} {'TP':>5} {'FP':>6} {'TN':>6} {'FN':>5}  "
          f"{'TPR':>6} {'FPR':>6} {'Prec':>6} {'F1':>6}      {'F2':>6}")
    print("-" * W)

    best_composite_f1 = max(
        metrics(y_true, [r["composite"] >= t for r in results])["f1"]
        for t in range(1, 5)
    )
    best_composite_f2 = max(
        metrics(y_true, [r["composite"] >= t for r in results], beta=2)["f2"]
        for t in range(1, 5)
    )
    for t in range(1, 5):
        y_pred = [r["composite"] >= t for r in results]
        m = metrics(y_true, y_pred, beta=2)
        f1_flag = " ◄F1" if abs(m["f1"] - best_composite_f1) < 0.001 else ""
        f2_flag = " ◄F2" if abs(m["f2"] - best_composite_f2) < 0.001 else ""
        print(f"  ≥{t:<7} {m['tp']:>5} {m['fp']:>6} {m['tn']:>6} {m['fn']:>5}  "
              f"{m['tpr']:>6.1%} {m['fpr']:>6.1%} {m['prec']:>6.1%} "
              f"{m['f1']:>6.3f}{f1_flag:<5} {m['f2']:>6.3f}{f2_flag}")

    # -----------------------------------------------------------------------
    # Individual factors at current thresholds
    # -----------------------------------------------------------------------
    factor_cfg = [
        ("DXY", "dxy_bearish", 7,  "dxy_score"),
        ("HYG", "hyg_bearish", 6,  "hyg_score"),
        ("SPY", "spy_bearish", 6,  "spy_score"),
        ("VIX", "vix_bearish", 5,  "vix_score"),
    ]
    print()
    print("Individual Factors (at current bearish thresholds)")
    print("-" * W)
    print(f"  {'Factor':<8} {'Thresh':>6}  {'TP':>5} {'FP':>6} {'TN':>6} {'FN':>5}  "
          f"{'TPR':>6} {'FPR':>6} {'F1':>6} {'F2':>7}")
    print("-" * W)
    for name, bkey, thresh, _ in factor_cfg:
        y_pred = [r[bkey] for r in results]
        m = metrics(y_true, y_pred, beta=2)
        print(f"  {name:<8} ≥{thresh:>5}  {m['tp']:>5} {m['fp']:>6} {m['tn']:>6} {m['fn']:>5}  "
              f"{m['tpr']:>6.1%} {m['fpr']:>6.1%} {m['f1']:>6.3f} {m['f2']:>7.3f}")

    # -----------------------------------------------------------------------
    # Score distribution: positive days vs negative days
    # -----------------------------------------------------------------------
    print()
    print("Score Distribution   avg ± σ  (positive = drop occurred, negative = no drop)")
    print("-" * W)
    print(f"  {'Factor':<8}  {'Positive days':>22}   {'Negative days':>22}")
    print("-" * W)
    for name, _, _, skey in factor_cfg:
        pos = [r[skey] for r in results if r["label"]]
        neg = [r[skey] for r in results if not r["label"]]
        pm, ps = mean_std(pos)
        nm, ns = mean_std(neg)
        print(f"  {name:<8}  {pm:>6.2f} ± {ps:.2f}{'':>10}   {nm:>6.2f} ± {ns:.2f}")

    # -----------------------------------------------------------------------
    # Threshold sensitivity: find best F1 score per factor
    # -----------------------------------------------------------------------
    print()
    print("Threshold Sensitivity (best F1 and F2 per factor across 0-10)")
    print("-" * W)
    print(f"  {'Factor':<8}  {'F1-opt ≥':>9} {'TPR':>6} {'F1':>6}   "
          f"{'F2-opt ≥':>9} {'TPR':>6} {'F2':>6}   {'current':>8}")
    print("-" * W)
    for name, _, curr_thresh, skey in factor_cfg:
        best_f1, best_t1, best_m1 = 0.0, 0, {}
        best_f2, best_t2, best_m2 = 0.0, 0, {}
        for t in range(0, 11):
            y_pred = [r[skey] >= t for r in results]
            m1 = metrics(y_true, y_pred, beta=1)
            m2 = metrics(y_true, y_pred, beta=2)
            if m1["f1"] > best_f1:
                best_f1, best_t1, best_m1 = m1["f1"], t, m1
            if m2["f2"] > best_f2:
                best_f2, best_t2, best_m2 = m2["f2"], t, m2
        print(f"  {name:<8}  ≥{best_t1:>7}  {best_m1['tpr']:>6.1%} {best_f1:>6.3f}   "
              f"≥{best_t2:>7}  {best_m2['tpr']:>6.1%} {best_f2:>6.3f}   "
              f"≥{curr_thresh:>6}")

    # -----------------------------------------------------------------------
    # Lead-time analysis at best composite threshold
    # -----------------------------------------------------------------------
    best_comp_t = max(range(1, 5),
                      key=lambda t: metrics(y_true, [r["composite"] >= t for r in results], beta=2)["f2"])
    flagged_pos = [r for r in results if r["composite"] >= best_comp_t and r["label"]]
    if flagged_pos:
        dd_vals = [abs(r["fwd_drawdown"]) for r in flagged_pos]
        avg_dd, _ = mean_std(dd_vals)
        print()
        print(f"True Positives at composite ≥{best_comp_t}  "
              f"(n={len(flagged_pos)}, avg forward drawdown={avg_dd:.1f}%)")
        buckets = [(0, 3), (3, 6), (6, 10), (10, float("inf"))]
        bucket_labels = ["0-3%", "3-6%", "6-10%", ">10%"]
        print("-" * 40)
        for (lo, hi), lbl in zip(buckets, bucket_labels):
            cnt = sum(1 for dd in dd_vals if lo <= dd < hi)
            print(f"  Drop {lbl:<8}  {cnt:>4} ({cnt/len(dd_vals):.0%})")

    # -----------------------------------------------------------------------
    # CSV export
    # -----------------------------------------------------------------------
    if csv_path:
        with open(csv_path, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(results[0].keys()))
            writer.writeheader()
            writer.writerows(results)
        print(f"\nPer-day results saved → {csv_path}")

    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Market Risk Score — Backtesting Harness"
    )
    parser.add_argument("--years",    type=int,   default=5,    help="Years of history (default: 5)")
    parser.add_argument("--drop-pct", type=float, default=5.0,  help="SPY drop threshold in %% (default: 5)")
    parser.add_argument("--window",   type=int,   default=14,   help="Forward window in trading days (default: 14)")
    parser.add_argument("--csv",      type=str,   default=None, help="Save per-day results to CSV")
    args = parser.parse_args()

    run_backtest(
        years=args.years,
        drop_pct=args.drop_pct / 100.0,
        fwd_window=args.window,
        csv_path=args.csv,
    )


if __name__ == "__main__":
    main()
