#!/usr/bin/env python3
"""
Basing Watch — streak engine for tickers in a downtrend.

Detects when a downtrend has stopped: counts consecutive Qualifying Days
(no Big Down Day, close inside the Band) and maps the streak to a state.

Definitions (see CONTEXT.md at the repo root):
  Big Down Day   close ≥3% below the prior close — resets the streak
  Band           ±5% around the anchor close (the last reset day's close);
                 a close outside the band, either direction, resets the streak
  Streak         consecutive Qualifying Days since the last reset
  State          streak ≥10 → base-confirmed, ≥5 → stabilizing, else downtrending

Usage:
  python3 basing_watch.py MU MRVL ARM            # human-readable report
  python3 basing_watch.py MU --json              # machine-readable
  python3 basing_watch.py MU --data '{"MU":[{"date":"2026-06-01","close":100.0},...]}'

Data source: Yahoo Finance public chart API (no auth), range=3mo daily closes.
The streak is always recomputed from the full window — there is no persisted
counter to corrupt; GBrain pages only carry watch membership and last state.
"""
import argparse
import datetime
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BIG_DOWN_PCT = 3.0
BAND_PCT = 5.0
STABILIZING_DAYS = 5
CONFIRMED_DAYS = 10

_CHART_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/"
    "{symbol}?range={range}&interval=1d&includePrePost=false"
)


def compute_watch(rows):
    """Compute streak/state from ascending [{"date", "close"}, ...] rows.

    The first row seeds the anchor; qualification starts from the second row.
    """
    rows = [r for r in rows if r.get("close") is not None]
    if len(rows) < 2:
        raise ValueError("need at least 2 closes to compute a basing watch")

    anchor = rows[0]
    streak = 0
    last_reset = None
    for prev, cur in zip(rows, rows[1:]):
        pct_change = (cur["close"] / prev["close"] - 1) * 100
        band_dev = (cur["close"] / anchor["close"] - 1) * 100
        if pct_change <= -BIG_DOWN_PCT:
            reason = "big-down-day"
        elif abs(band_dev) > BAND_PCT:
            reason = "band-breach"
        else:
            streak += 1
            continue
        streak = 0
        anchor = cur
        last_reset = {"date": cur["date"], "reason": reason}

    if streak >= CONFIRMED_DAYS:
        state = "base-confirmed"
    elif streak >= STABILIZING_DAYS:
        state = "stabilizing"
    else:
        state = "downtrending"

    latest, prior = rows[-1], rows[-2]
    band_low = anchor["close"] * (1 - BAND_PCT / 100)
    band_high = anchor["close"] * (1 + BAND_PCT / 100)
    return {
        "state": state,
        "streak": streak,
        "anchor": {"date": anchor["date"], "close": anchor["close"]},
        "band": {"low": band_low, "high": band_high},
        "latest": {
            "date": latest["date"],
            "close": latest["close"],
            "pct_change": (latest["close"] / prior["close"] - 1) * 100,
        },
        "last_reset": last_reset,
        "distance": {
            "to_band_low_pct": (latest["close"] - band_low) / latest["close"] * 100,
            "to_band_high_pct": (band_high - latest["close"]) / latest["close"] * 100,
        },
        "thresholds": {
            "big_down_pct": BIG_DOWN_PCT,
            "band_pct": BAND_PCT,
            "stabilizing_days": STABILIZING_DAYS,
            "confirmed_days": CONFIRMED_DAYS,
        },
    }


def fetch_closes(symbol, range_="3mo"):
    url = _CHART_URL.format(symbol=urllib.parse.quote(symbol, safe=""), range=range_)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.load(resp)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as e:
        raise RuntimeError(f"{symbol}: Yahoo fetch failed: {e}") from e
    try:
        result = payload["chart"]["result"][0]
        timestamps = result["timestamp"]
        closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError) as e:
        raise RuntimeError(f"{symbol}: unexpected Yahoo response shape: {e}") from e

    tz = result.get("meta", {}).get("exchangeTimezoneName") or "America/New_York"
    try:
        from zoneinfo import ZoneInfo

        tzinfo = ZoneInfo(tz)
    except Exception:
        tzinfo = None
    rows = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        d = datetime.datetime.fromtimestamp(ts, tz=tzinfo).date()
        rows.append({"date": d.isoformat(), "close": float(close)})
    return rows


def _format_report(results):
    lines = []
    for ticker, r in results.items():
        if "error" in r:
            lines.append(f"{ticker}: ERROR — {r['error']}")
            continue
        streak_txt = f"day {r['streak']}/{CONFIRMED_DAYS}"
        reset = r["last_reset"]
        reset_txt = f", last reset {reset['date']} ({reset['reason']})" if reset else ""
        lines.append(
            f"{ticker}: {r['state']} ({streak_txt}) — close {r['latest']['close']:.2f} "
            f"({r['latest']['pct_change']:+.2f}%) on {r['latest']['date']}, "
            f"band {r['band']['low']:.2f}–{r['band']['high']:.2f} "
            f"(room -{r['distance']['to_band_low_pct']:.1f}% / +{r['distance']['to_band_high_pct']:.1f}%)"
            f"{reset_txt}"
        )
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Basing-watch streak engine")
    parser.add_argument("tickers", nargs="+", help="ticker symbols, e.g. MU MRVL ARM")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--range", default="3mo", help="Yahoo lookback range (default 3mo)")
    parser.add_argument(
        "--data",
        help='pre-fetched closes as JSON: {"MU": [{"date": "...", "close": 100.0}, ...]}',
    )
    args = parser.parse_args(argv)

    prefetched = json.loads(args.data) if args.data else {}
    results = {}
    for ticker in args.tickers:
        ticker = ticker.upper().lstrip("$")
        try:
            rows = prefetched.get(ticker) or fetch_closes(ticker, args.range)
            results[ticker] = compute_watch(rows)
        except (RuntimeError, ValueError) as e:
            results[ticker] = {"error": str(e)}

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(_format_report(results))
    return 1 if any("error" in r for r in results.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
