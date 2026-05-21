#!/usr/bin/env python3
"""
US Market Risk Score
Calculates a composite risk score from DXY, HYG, SPY, VIX.

Usage:
  python3 market_risk_score.py                          # today, yf-api
  python3 market_risk_score.py --date "last monday"
  python3 market_risk_score.py --date 2026-05-16
  python3 market_risk_score.py --source browser-json --data '{"DX-Y.NYB":[...],...}'
  python3 market_risk_score.py --json                   # machine-readable output

Data sources:
  yf-api        Yahoo Finance public JSON API (default, no auth required)
  browser-json  Agent provides pre-fetched JSON from browser
"""
import json
import sys
import urllib.request
import urllib.error
import urllib.parse
import datetime
import argparse
from abc import ABC, abstractmethod


# ---------------------------------------------------------------------------
# Tickers
# ---------------------------------------------------------------------------

TICKERS = {
    "DXY": "DX-Y.NYB",
    "HYG": "HYG",
    "SPY": "SPY",
    "VIX": "^VIX",
}

FACTOR_LABELS = {
    "DXY": "$DXY (Dollar)",
    "HYG": "$HYG (HY Bonds)",
    "SPY": "$SPY (S&P 500)",
    "VIX": "$VIX (Volatility)",
}


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

def parse_date(date_str: str) -> datetime.date:
    today = datetime.date.today()
    s = date_str.lower().strip()

    if s in ("today", "now"):
        return today
    if s == "yesterday":
        return today - datetime.timedelta(days=1)
    if s.startswith("last "):
        day_name = s[5:].strip()
        names = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
                 "friday": 4, "saturday": 5, "sunday": 6}
        if day_name in names:
            target_wd = names[day_name]
            days_ago = (today.weekday() - target_wd) % 7 or 7
            return today - datetime.timedelta(days=days_ago)
    try:
        return datetime.date.fromisoformat(date_str)
    except ValueError:
        raise ValueError(
            f"Cannot parse date '{date_str}'. "
            "Use: 'today', 'last monday', 'yesterday', or YYYY-MM-DD."
        )


def nearest_prior_weekday(d: datetime.date) -> datetime.date:
    while d.weekday() >= 5:
        d -= datetime.timedelta(days=1)
    return d


# ---------------------------------------------------------------------------
# Data source interface
# ---------------------------------------------------------------------------

class DataSource(ABC):
    @abstractmethod
    def fetch(self, symbol: str, target_date: datetime.date) -> list:
        """Return [(date, close), ...] sorted ascending, ending on/before target_date."""


class YahooFinanceApiSource(DataSource):
    """Yahoo Finance public chart API — no authentication required."""

    _URL = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        "{symbol}?range=3mo&interval=1d&includePrePost=false"
    )

    def fetch(self, symbol: str, target_date: datetime.date) -> list:
        url = self._URL.format(symbol=urllib.parse.quote(symbol, safe=""))
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; market-risk-score/1.0)",
            "Accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"HTTP {e.code} fetching {symbol}")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ValueError) as e:
            raise RuntimeError(f"Network error fetching {symbol}: {e}")

        try:
            result = data.get("chart", {}).get("result") or []
            if not result:
                err = data.get("chart", {}).get("error", {})
                raise RuntimeError(f"No data for {symbol}: {err}")
            quotes = result[0].get("indicators", {}).get("quote") or []
            if not quotes:
                raise RuntimeError(f"Empty quote array for {symbol}")
            timestamps = result[0].get("timestamp", [])
            closes = quotes[0].get("close", [])
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Failed to parse response for {symbol}: {e}")

        pairs = []
        for ts, c in zip(timestamps, closes):
            if c is None:
                continue
            # Use UTC date to avoid host-timezone shifting US equity closes to next day
            d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date()
            if d <= target_date:
                pairs.append((d, float(c)))

        pairs.sort(key=lambda x: x[0])
        return pairs


class BrowserJsonSource(DataSource):
    """
    Agent fetches data via browser and provides it as JSON.

    Expected JSON format:
    {
      "DX-Y.NYB": [{"date": "2026-05-19", "close": 104.5}, ...],
      "HYG":      [...],
      "SPY":      [...],
      "^VIX":     [...]
    }
    Each list must be sorted ascending and cover at least 25 trading days.
    """

    def __init__(self, raw_json: str):
        self._data = json.loads(raw_json)

    def fetch(self, symbol: str, target_date: datetime.date) -> list:
        rows = self._data.get(symbol, [])
        pairs = []
        try:
            for row in rows:
                d = datetime.date.fromisoformat(row["date"])
                if d <= target_date:
                    pairs.append((d, float(row["close"])))
        except (KeyError, ValueError, TypeError) as e:
            raise RuntimeError(f"Malformed browser-json entry for {symbol}: {e}")
        pairs.sort(key=lambda x: x[0])
        return pairs


# ---------------------------------------------------------------------------
# Indicators
# ---------------------------------------------------------------------------

def sma(closes: list, n: int):
    return sum(closes[-n:]) / n if len(closes) >= n else None


def rsi14(closes: list):
    if len(closes) < 15:
        return None
    deltas = [closes[i] - closes[i - 1] for i in range(len(closes) - 14, len(closes))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    avg_gain = sum(gains) / 14
    avg_loss = sum(losses) / 14
    if avg_loss == 0 and avg_gain == 0:
        return 50.0  # flat series — no directional bias
    if avg_loss == 0:
        return 100.0
    return 100.0 - (100.0 / (1.0 + avg_gain / avg_loss))


def return_n_days(closes: list, n: int):
    if len(closes) <= n:
        return None
    old = closes[-(n + 1)]
    return (closes[-1] - old) / old if old != 0 else None


# ---------------------------------------------------------------------------
# Per-factor signal computation
# ---------------------------------------------------------------------------

def compute_signals(source: DataSource, trading_day: datetime.date) -> tuple:
    signals = {}
    raw = {}

    for label, symbol in TICKERS.items():
        try:
            pairs = source.fetch(symbol, trading_day)
        except RuntimeError as e:
            signals[label] = None
            raw[label] = {"error": str(e)}
            continue

        if len(pairs) < 20:
            signals[label] = None
            raw[label] = {"error": f"Only {len(pairs)} trading days, need ≥20"}
            continue

        closes = [p[1] for p in pairs]
        current = closes[-1]
        current_date = str(pairs[-1][0])
        s20 = sma(closes, 20)
        s10 = sma(closes, 10)
        rsi = rsi14(closes)
        ret5 = return_n_days(closes, 5)

        r = {
            "close": round(current, 4),
            "close_date": current_date,
            "sma20": round(s20, 4) if s20 is not None else None,
            "sma10": round(s10, 4) if s10 is not None else None,
            "rsi14": round(rsi, 2) if rsi is not None else None,
            "ret5d_pct": round(ret5 * 100, 3) if ret5 is not None else None,
        }

        if label == "DXY":
            above_sma = s20 is not None and current > s20
            strong_ret = ret5 is not None and ret5 > 0.005
            bearish = above_sma and strong_ret
            reason = (
                f"${current:.2f} {'>' if above_sma else '<'} SMA20 ${s20:.2f}"
                + (f", {ret5*100:+.2f}% 5d" if ret5 is not None else "")
            ) if s20 is not None else "SMA20 unavailable"

        elif label == "HYG":
            below_sma = s20 is not None and current < s20
            weak_ret = ret5 is not None and ret5 < -0.003
            bearish = below_sma and weak_ret
            reason = (
                f"${current:.2f} {'<' if below_sma else '>'} SMA20 ${s20:.2f}"
                + (f", {ret5*100:+.2f}% 5d" if ret5 is not None else "")
            ) if s20 is not None else "SMA20 unavailable"

        elif label == "SPY":
            below_sma = s20 is not None and current < s20
            rsi_weak = rsi is not None and rsi < 50
            bearish = below_sma or rsi_weak
            parts = []
            if rsi is not None:
                parts.append(f"RSI {rsi:.0f}")
            if s20 is not None:
                parts.append(f"${current:.0f} {'<' if below_sma else '>'} SMA20 ${s20:.0f}")
            reason = ", ".join(parts) or "insufficient data"

        elif label == "VIX":
            bearish = current < 18
            reason = f"VIX {current:.2f} {'< 18 (complacency)' if bearish else '>= 18'}"

        else:
            bearish = False
            reason = "unknown factor"

        r["bearish"] = bearish
        r["reason"] = reason
        signals[label] = bearish
        raw[label] = r

    return signals, raw


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

_BANDS = [
    (0, "Risk On",  "✅", "conditions supportive of equities"),
    (1, "Neutral",  "🟡", "mixed signals, no strong directional bias"),
    (2, "Caution",  "⚠️",  "multiple warning signs, consider reducing exposure"),
    (3, "Risk Off", "🔴", "significant stress, avoid new longs"),
]


def classify(bearish_count: int, known: int) -> tuple:
    if known < 3:
        return "Insufficient Data", "❓", f"only {known}/4 factors available — score unreliable"
    for threshold, label, icon, desc in reversed(_BANDS):
        if bearish_count >= threshold:
            return label, icon, desc


# ---------------------------------------------------------------------------
# Formatted output
# ---------------------------------------------------------------------------

def format_output(target_date, trading_day, signals, raw) -> str:
    bearish_count = sum(1 for v in signals.values() if v is True)
    known = sum(1 for v in signals.values() if v is not None)
    unknown = len(TICKERS) - known
    classification, icon, desc = classify(bearish_count, known)

    lines = [
        f"US Market Risk Score — {trading_day}",
        f"{icon} {classification} ({bearish_count}/{known} bearish signals) — {desc}",
        "",
    ]

    for key in ("DXY", "HYG", "SPY", "VIX"):
        sig = signals.get(key)
        r = raw.get(key, {})
        if sig is None:
            si, st = "❓", "Unknown "
            detail = r.get("error", "no data")
        elif sig:
            si, st = "🔴", "Bearish "
            detail = r.get("reason", "")
        else:
            si, st = "✅", "Bullish "
            detail = r.get("reason", "")
        label = FACTOR_LABELS[key]
        lines.append(f"  {si} {label:<22} {st}  {detail}")

    if target_date != trading_day:
        lines.append(f"\n  (Note: {target_date} is a weekend/holiday — using {trading_day})")
    if unknown:
        lines.append(f"\n  ⚠ {unknown} factor(s) unavailable — score based on {known}/4 factors")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="US Market Risk Score — DXY, HYG, SPY, VIX"
    )
    parser.add_argument(
        "--date", default="today",
        help="'today', 'last monday', 'yesterday', or YYYY-MM-DD (default: today)"
    )
    parser.add_argument(
        "--source", choices=["yf-api", "browser-json"], default="yf-api",
        help="Data source (default: yf-api)"
    )
    parser.add_argument(
        "--data", default=None,
        help="JSON string for --source browser-json"
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output machine-readable JSON"
    )
    args = parser.parse_args()

    try:
        target_date = parse_date(args.date)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    trading_day = nearest_prior_weekday(target_date)

    if args.source == "browser-json":
        if not args.data:
            print("Error: --data JSON required for --source browser-json", file=sys.stderr)
            sys.exit(1)
        source = BrowserJsonSource(args.data)
    else:
        source = YahooFinanceApiSource()

    signals, raw = compute_signals(source, trading_day)
    bearish_count = sum(1 for v in signals.values() if v is True)
    known = sum(1 for v in signals.values() if v is not None)
    classification, icon, desc = classify(bearish_count, known)

    if args.json:
        print(json.dumps({
            "target_date": str(target_date),
            "trading_day": str(trading_day),
            "classification": classification,
            "bearish_count": bearish_count,
            "signals": signals,
            "raw": raw,
        }, indent=2))
    else:
        print(format_output(target_date, trading_day, signals, raw))


if __name__ == "__main__":
    main()
