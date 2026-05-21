#!/usr/bin/env python3
"""
US Market Risk Score — DXY Equity Risk Monitor
Calculates a composite risk score from DXY, HYG, SPY, VIX.

Data lookback:
  DXY   uses OHLC data + 1-year lookback (range=1y)
  HYG, SPY, VIX use close-only data + 3-month lookback (range=3mo)

Usage:
  python3 market_risk_score.py                          # today, yf-api
  python3 market_risk_score.py --date "last monday"
  python3 market_risk_score.py --date 2026-05-16
  python3 market_risk_score.py --source browser-json --data '{"DX-Y.NYB":[...],...}'
  python3 market_risk_score.py --json                   # machine-readable output
  python3 market_risk_score.py --dxy-only               # DXY signals only
  python3 market_risk_score.py --dxy-only --json        # DXY signals as JSON

Data sources:
  yf-api        Yahoo Finance public JSON API (default, no auth required)
  browser-json  Agent provides pre-fetched JSON from browser

Browser-JSON schema:
  {
    "DX-Y.NYB": [
      {"date": "2026-05-19", "high": 100.5, "low": 99.8, "close": 100.2},
      ...
    ],
    "HYG":  [{"date": "2026-05-19", "close": 79.1}, ...],
    "SPY":  [{"date": "2026-05-19", "close": 527.3}, ...],
    "^VIX": [{"date": "2026-05-19", "close": 18.5}, ...]
  }
  DXY rows require "high" and "low" fields.
  HYG/SPY/VIX rows require only "close".
  Each list must be sorted ascending.
  DXY must cover at least 210 trading days (~1 year).
  HYG/SPY/VIX must cover at least 20 trading days.
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

    @abstractmethod
    def fetch_ohlc(self, symbol: str, target_date: datetime.date) -> list:
        """Return [(date, high, low, close), ...] sorted ascending, ending on/before target_date."""


class YahooFinanceApiSource(DataSource):
    """Yahoo Finance public chart API — no authentication required."""

    _URL_3MO = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        "{symbol}?range=3mo&interval=1d&includePrePost=false"
    )

    _URL_1Y = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        "{symbol}?range=1y&interval=1d&includePrePost=false"
    )

    def _request(self, url: str, symbol: str) -> dict:
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
        return data

    def fetch(self, symbol: str, target_date: datetime.date) -> list:
        url = self._URL_3MO.format(symbol=urllib.parse.quote(symbol, safe=""))
        data = self._request(url, symbol)

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

    def fetch_ohlc(self, symbol: str, target_date: datetime.date) -> list:
        url = self._URL_1Y.format(symbol=urllib.parse.quote(symbol, safe=""))
        data = self._request(url, symbol)

        try:
            result = data.get("chart", {}).get("result") or []
            if not result:
                err = data.get("chart", {}).get("error", {})
                raise RuntimeError(f"No data for {symbol}: {err}")
            quotes = result[0].get("indicators", {}).get("quote") or []
            if not quotes:
                raise RuntimeError(f"Empty quote array for {symbol}")
            timestamps = result[0].get("timestamp", [])
            highs = quotes[0].get("high", [])
            lows = quotes[0].get("low", [])
            closes = quotes[0].get("close", [])
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Failed to parse OHLC response for {symbol}: {e}")

        rows = []
        for ts, h, l, c in zip(timestamps, highs, lows, closes):
            if h is None or l is None or c is None:
                continue
            d = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc).date()
            if d <= target_date:
                rows.append((d, float(h), float(l), float(c)))

        rows.sort(key=lambda x: x[0])
        return rows


class BrowserJsonSource(DataSource):
    """
    Agent fetches data via browser and provides it as JSON.

    Expected JSON format:
    {
      "DX-Y.NYB": [{"date": "2026-05-19", "high": 100.5, "low": 99.8, "close": 100.2}, ...],
      "HYG":      [{"date": "2026-05-19", "close": 79.1}, ...],
      "SPY":      [{"date": "2026-05-19", "close": 527.3}, ...],
      "^VIX":     [{"date": "2026-05-19", "close": 18.5}, ...]
    }
    DXY rows require "high" and "low". HYG/SPY/VIX require only "close".
    Each list must be sorted ascending.
    DXY must cover at least 210 trading days. HYG/SPY/VIX at least 20.
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

    def fetch_ohlc(self, symbol: str, target_date: datetime.date) -> list:
        rows = self._data.get(symbol, [])
        result = []
        try:
            for row in rows:
                d = datetime.date.fromisoformat(row["date"])
                if d > target_date:
                    continue
                if "high" not in row or "low" not in row:
                    raise RuntimeError(
                        f"browser-json entry for {symbol} on {row.get('date')} "
                        f"is missing required 'high' and/or 'low' fields"
                    )
                result.append((d, float(row["high"]), float(row["low"]), float(row["close"])))
        except RuntimeError:
            raise
        except (KeyError, ValueError, TypeError) as e:
            raise RuntimeError(f"Malformed browser-json OHLC entry for {symbol}: {e}")
        result.sort(key=lambda x: x[0])
        return result


# ---------------------------------------------------------------------------
# Indicators — close-only
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
# Indicators — DXY helpers
# ---------------------------------------------------------------------------

def rolling_max_excl_today(closes, n):
    """Max of previous n closes, excluding the last element (today)."""
    if len(closes) < n + 1:
        return None
    return max(closes[-(n + 1):-1])


def stdev_sample(values, n):
    if len(values) < n:
        return None
    window = values[-n:]
    mean = sum(window) / n
    return (sum((x - mean) ** 2 for x in window) / (n - 1)) ** 0.5


def zscore_n(values, n):
    s = sma(values, n)
    sd = stdev_sample(values, n)
    if s is None or sd is None or sd == 0:
        return None
    return (values[-1] - s) / sd


def true_range_series(highs, lows, closes):
    return [max(highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]))
            for i in range(1, len(closes))]


def wilder_rma_series(values, n):
    if len(values) < n:
        return []
    result = [sum(values[:n]) / n]
    for v in values[n:]:
        result.append((result[-1] * (n - 1) + v) / n)
    return result


def calc_atr14(highs, lows, closes):
    trs = true_range_series(highs, lows, closes)
    series = wilder_rma_series(trs, 14)
    return series[-1] if series else None


def calc_adx14(highs, lows, closes):
    """Returns (adx, plus_di, minus_di) or (None, None, None)."""
    if len(closes) < 30:
        return None, None, None
    plus_dms, minus_dms, trs = [], [], []
    for i in range(1, len(closes)):
        up = highs[i] - highs[i - 1]
        dn = lows[i - 1] - lows[i]
        plus_dms.append(up if up > dn and up > 0 else 0.0)
        minus_dms.append(dn if dn > up and dn > 0 else 0.0)
        trs.append(max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1])))
    s_tr = wilder_rma_series(trs, 14)
    s_pdm = wilder_rma_series(plus_dms, 14)
    s_mdm = wilder_rma_series(minus_dms, 14)
    if not s_tr:
        return None, None, None
    dx_vals, pdi_last, mdi_last = [], 0.0, 0.0
    for tr, pdm, mdm in zip(s_tr, s_pdm, s_mdm):
        if tr == 0:
            continue
        pdi = 100 * pdm / tr
        mdi = 100 * mdm / tr
        denom = pdi + mdi
        dx_vals.append(100 * abs(pdi - mdi) / denom if denom else 0.0)
        pdi_last, mdi_last = pdi, mdi
    adx_series = wilder_rma_series(dx_vals, 14)
    if not adx_series:
        return None, None, None
    return adx_series[-1], pdi_last, mdi_last


def bollinger_bands(closes, n=20, k=2):
    mid = sma(closes, n)
    sd = stdev_sample(closes, n)
    if mid is None or sd is None:
        return None, None, None
    return mid, mid + k * sd, mid - k * sd


# ---------------------------------------------------------------------------
# DXY score computation
# ---------------------------------------------------------------------------

_DXY_MIN_BARS = 210


def compute_dxy_score(dxy_ohlc, spy_closes, hyg_closes):
    if len(dxy_ohlc) < _DXY_MIN_BARS:
        return {
            "error": f"Insufficient DXY data: {len(dxy_ohlc)} bars, need ≥{_DXY_MIN_BARS}",
            "bearish": None,
            "dxy_equity_risk_score": None,
        }

    highs = [x[1] for x in dxy_ohlc]
    lows = [x[2] for x in dxy_ohlc]
    closes = [x[3] for x in dxy_ohlc]
    current = closes[-1]
    close_date = str(dxy_ohlc[-1][0])

    p60 = rolling_max_excl_today(closes, 60)
    p90 = rolling_max_excl_today(closes, 90)
    p120 = rolling_max_excl_today(closes, 120)
    s20 = sma(closes, 20)
    s50 = sma(closes, 50)
    s200 = sma(closes, 200)
    roc10 = return_n_days(closes, 10)
    roc20 = return_n_days(closes, 20)
    z60 = zscore_n(closes, 60)
    atr = calc_atr14(highs, lows, closes)
    adx, plus_di, minus_di = calc_adx14(highs, lows, closes)
    bb_mid, bb_upper, bb_lower = bollinger_bands(closes, 20, 2)
    bb_width = (bb_upper - bb_lower) / bb_mid if bb_mid and bb_mid != 0 else None

    # bb_width 5 days ago
    bb_width_expanding = None
    if len(closes) >= 25 and bb_width is not None:
        bm5, bu5, bl5 = bollinger_bands(closes[:-5], 20, 2)
        if bm5 and bm5 != 0:
            bb_width_expanding = bb_width > (bu5 - bl5) / bm5

    # confirmed breakout: 2 of last 3 days above their prior 60d high
    confirmed_breakout = None
    if len(closes) >= 63:
        count = 0
        for off in range(3):
            window = closes[:len(closes) - off]
            prev_60d_high = rolling_max_excl_today(window, 60)
            if prev_60d_high is not None and window[-1] > prev_60d_high:
                count += 1
        confirmed_breakout = count >= 2

    spy_roc10 = return_n_days(spy_closes, 10) if len(spy_closes) > 10 else None
    spy_roc20 = return_n_days(spy_closes, 20) if len(spy_closes) > 20 else None
    hyg_roc10 = return_n_days(hyg_closes, 10) if len(hyg_closes) > 10 else None

    # HYG SMA for equity_risk_confirmed
    hyg_s20 = sma(hyg_closes, 20)
    hyg_s50 = sma(hyg_closes, 50)
    hyg_close = hyg_closes[-1] if hyg_closes else None

    # ATR-adjusted breakout
    atr_breakout = (p60 is not None and atr is not None and current > p60 + 0.25 * atr)

    # Individual signals (boolean)
    sig = {
        "breakout_60d":            p60 is not None and current > p60,
        "breakout_90d":            p90 is not None and current > p90,
        "breakout_confirmed_2of3": confirmed_breakout,
        "above_sma20_and_sma50":   s20 is not None and s50 is not None and current > s20 and current > s50,
        "sma20_above_sma50":       s20 is not None and s50 is not None and s20 > s50,
        "roc10_above_1pct":        roc10 is not None and roc10 > 0.01,
        "roc20_above_2pct":        roc20 is not None and roc20 > 0.02,
        "zscore_above_1_5":        z60 is not None and z60 > 1.5,
        "atr_adjusted_breakout":   atr_breakout,
        "adx_trending":            adx is not None and plus_di is not None and minus_di is not None and adx > 25 and plus_di > minus_di,
        "bb_breakout":             bb_upper is not None and current > bb_upper and bb_width_expanding is True,
        "dxy_spy_divergence":      roc20 is not None and spy_roc20 is not None and roc20 > 0 and spy_roc20 < 0,
        "dxy_hyg_confirmed":       roc10 is not None and hyg_roc10 is not None and spy_roc10 is not None and roc10 > 0.01 and hyg_roc10 < spy_roc10,
    }

    # Score per rubric (capped at 10)
    bd = {
        "breakout_60d":          2 if sig["breakout_60d"] else 0,
        "breakout_90d":          1 if sig["breakout_90d"] else 0,
        "above_sma20_and_sma50": 1 if sig["above_sma20_and_sma50"] else 0,
        "sma20_above_sma50":     1 if sig["sma20_above_sma50"] else 0,
        "roc10_above_1pct":      1 if sig["roc10_above_1pct"] else 0,
        "roc20_above_2pct":      1 if sig["roc20_above_2pct"] else 0,
        "zscore_above_1_5":      1 if sig["zscore_above_1_5"] else 0,
        "atr_adjusted_breakout": 1 if sig["atr_adjusted_breakout"] else 0,
        "adx_trending":          1 if sig["adx_trending"] else 0,
        "dxy_spy_divergence":    1 if sig["dxy_spy_divergence"] else 0,
        "dxy_hyg_confirmed":     1 if sig["dxy_hyg_confirmed"] else 0,
    }
    score = min(sum(bd.values()), 10)

    # Alerts
    breakout_warning = bool(
        sig["breakout_60d"] and s20 is not None and current > s20 and
        sig["sma20_above_sma50"] and sig["roc10_above_1pct"]
    )
    hyg_breakdown = (
        hyg_close is not None and hyg_s20 is not None and hyg_s50 is not None
        and hyg_close < hyg_s20 and hyg_close < hyg_s50
    )
    equity_risk_confirmed = breakout_warning and (
        (spy_roc20 is not None and spy_roc20 < 0) or
        (hyg_roc10 is not None and spy_roc10 is not None and hyg_roc10 < spy_roc10) or
        hyg_breakdown
    )

    # Risk label
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

    bearish = score >= 7

    # Reason string
    parts = []
    if bd["breakout_60d"]:
        parts.append(f"60d break +{bd['breakout_60d']}")
    if bd["breakout_90d"]:
        parts.append("90d break +1")
    if bd["above_sma20_and_sma50"]:
        parts.append("SMA stack +1")
    if bd["sma20_above_sma50"]:
        parts.append("SMA20>SMA50 +1")
    if bd["roc10_above_1pct"] and roc10:
        parts.append(f"ROC10 {roc10 * 100:+.1f}% +1")
    if bd["roc20_above_2pct"] and roc20:
        parts.append(f"ROC20 {roc20 * 100:+.1f}% +1")
    if bd["zscore_above_1_5"] and z60:
        parts.append(f"z {z60:.1f} +1")
    if bd["atr_adjusted_breakout"]:
        parts.append("ATR break +1")
    if bd["adx_trending"] and adx:
        parts.append(f"ADX {adx:.0f} +1")
    if bd["dxy_spy_divergence"] and spy_roc20:
        parts.append(f"SPY {spy_roc20 * 100:+.1f}% +1")
    if bd["dxy_hyg_confirmed"]:
        parts.append("HYG confirmed +1")
    reason = f"{score}/10 {risk_label}"
    if parts:
        reason += " — " + ", ".join(parts)
    if breakout_warning:
        reason += " [BREAKOUT]"
    if equity_risk_confirmed:
        reason += " [RISK CONFIRMED]"

    def _r(v, d=4):
        return round(v, d) if v is not None else None

    return {
        # Output fields
        "close":              _r(current),
        "close_date":         close_date,
        "dxy_close":          _r(current),
        "dxy_60d_high":       _r(p60),
        "dxy_90d_high":       _r(p90),
        "dxy_120d_high":      _r(p120),
        "dxy_sma20":          _r(s20),
        "dxy_sma50":          _r(s50),
        "dxy_sma200":         _r(s200),
        "dxy_roc10":          _r(roc10, 6),
        "dxy_roc20":          _r(roc20, 6),
        "dxy_zscore_60":      _r(z60),
        "dxy_atr14":          _r(atr),
        "dxy_adx14":          _r(adx, 2) if adx else None,
        "dxy_plus_di":        _r(plus_di, 2) if plus_di else None,
        "dxy_minus_di":       _r(minus_di, 2) if minus_di else None,
        "dxy_bb_upper":       _r(bb_upper),
        "dxy_bb_lower":       _r(bb_lower),
        "dxy_bb_width":       _r(bb_width, 6),
        "dxy_bb_width_expanding": bb_width_expanding,
        "spy_roc10":          _r(spy_roc10, 6),
        "spy_roc20":          _r(spy_roc20, 6),
        "hyg_roc10":          _r(hyg_roc10, 6),
        "confirmed_breakout_2of3": confirmed_breakout,
        # Alerts
        "breakout_warning":          breakout_warning,
        "dxy_equity_risk_confirmed": equity_risk_confirmed,
        "dxy_equity_risk_score":     score,
        "risk_label":                risk_label,
        # All signal booleans
        "signals":       sig,
        # Point contribution per signal
        "score_breakdown": bd,
        # Classification
        "bearish": bearish,
        "reason":  reason,
        # Legacy keys for backwards compat
        "sma20":     _r(s20),
        "rsi14":     None,
        "ret5d_pct": _r(return_n_days(closes, 5), 3) if return_n_days(closes, 5) is not None else None,
    }


# ---------------------------------------------------------------------------
# Per-factor signal computation
# ---------------------------------------------------------------------------

def compute_signals(source: DataSource, trading_day: datetime.date) -> tuple:
    signals = {}
    raw = {}

    # Phase A — fetch all data, collecting errors per symbol without aborting
    close_data = {}
    dxy_ohlc = []

    for label, symbol in TICKERS.items():
        if label == "DXY":
            try:
                dxy_ohlc = source.fetch_ohlc(symbol, trading_day)
            except RuntimeError as e:
                signals["DXY"] = None
                raw["DXY"] = {"error": str(e)}
                dxy_ohlc = []
        else:
            try:
                close_data[label] = source.fetch(symbol, trading_day)
            except RuntimeError as e:
                signals[label] = None
                raw[label] = {"error": str(e)}
                close_data[label] = None

    spy_closes = [p[1] for p in close_data.get("SPY") or []]
    hyg_closes = [p[1] for p in close_data.get("HYG") or []]

    # Phase B — compute signals

    # DXY: full scoring model
    if "DXY" not in raw:
        result = compute_dxy_score(dxy_ohlc, spy_closes, hyg_closes)
        signals["DXY"] = result["bearish"]
        raw["DXY"] = result

    # HYG, SPY, VIX: existing inline logic (unchanged)
    for label in ("HYG", "SPY", "VIX"):
        if label in raw:
            # already has an error entry from fetch phase
            continue

        pairs = close_data.get(label)
        if pairs is None or len(pairs) < 20:
            signals[label] = None
            raw[label] = {"error": f"Only {len(pairs) if pairs else 0} trading days, need ≥20"}
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

        if label == "HYG":
            below_sma = s20 is not None and current < s20
            weak_ret = ret5 is not None and ret5 < -0.003
            bearish = below_sma and weak_ret
            reason = (
                f"${current:.2f} {'<' if below_sma else '>'} SMA20 ${s20:.2f}"
                + (f", {ret5 * 100:+.2f}% 5d" if ret5 is not None else "")
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
    (1, "Neutral",  "\U0001f7e1", "mixed signals, no strong directional bias"),
    (2, "Caution",  "⚠️",  "multiple warning signs, consider reducing exposure"),
    (3, "Risk Off", "\U0001f534", "significant stress, avoid new longs"),
]


def classify(bearish_count: int, known: int) -> tuple:
    if known < 3:
        return "Insufficient Data", "❓", f"only {known}/4 factors available — score unreliable"
    for threshold, label, icon, desc in reversed(_BANDS):
        if bearish_count >= threshold:
            return label, icon, desc


# ---------------------------------------------------------------------------
# Formatted output — main summary
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
        if key == "DXY" and sig is not None:
            score = r.get("dxy_equity_risk_score", 0) or 0
            if score >= 7:
                si, st = "\U0001f534", "Bearish "
            elif score >= 4:
                si, st = "\U0001f7e1", "Caution "
            else:
                si, st = "✅", "Bullish "
            detail = r.get("reason", "")
        elif sig is None:
            si, st = "❓", "Unknown "
            detail = r.get("error", "no data")
        elif sig:
            si, st = "\U0001f534", "Bearish "
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
# Formatted output — DXY only
# ---------------------------------------------------------------------------

def format_dxy_output(trading_day, r) -> str:
    if r.get("error"):
        return f"DXY Equity Risk Monitor — {trading_day}\n\nError: {r['error']}"

    score = r.get("dxy_equity_risk_score", 0) or 0
    risk_label = r.get("risk_label", "")
    reason = r.get("reason", "")

    if score >= 7:
        score_icon = "\U0001f534"
    elif score >= 4:
        score_icon = "\U0001f7e1"
    else:
        score_icon = "✅"

    def _fmt(v, fmt=".4f"):
        if v is None:
            return "n/a"
        return format(v, fmt)

    lines = [
        f"DXY Equity Risk Monitor — {trading_day}",
        f"{score_icon} Score {score}/10 — {risk_label}",
        f"   {reason}",
        "",
        "Price & Trend",
        f"  Close:       {_fmt(r.get('dxy_close'), '.4f')}   (date: {r.get('close_date', 'n/a')})",
        f"  60d High:    {_fmt(r.get('dxy_60d_high'))}",
        f"  90d High:    {_fmt(r.get('dxy_90d_high'))}",
        f"  SMA20:       {_fmt(r.get('dxy_sma20'))}",
        f"  SMA50:       {_fmt(r.get('dxy_sma50'))}",
        f"  SMA200:      {_fmt(r.get('dxy_sma200'))}",
        f"  ROC10:       {_fmt(r.get('dxy_roc10'), '+.2%') if r.get('dxy_roc10') is not None else 'n/a'}",
        f"  ROC20:       {_fmt(r.get('dxy_roc20'), '+.2%') if r.get('dxy_roc20') is not None else 'n/a'}",
        f"  Z-score(60): {_fmt(r.get('dxy_zscore_60'), '.2f')}",
        f"  ATR14:       {_fmt(r.get('dxy_atr14'), '.4f')}",
        f"  ADX14:       {_fmt(r.get('dxy_adx14'), '.2f')}  (+DI {_fmt(r.get('dxy_plus_di'), '.2f')}  -DI {_fmt(r.get('dxy_minus_di'), '.2f')})",
        f"  BB Upper:    {_fmt(r.get('dxy_bb_upper'))}  Lower: {_fmt(r.get('dxy_bb_lower'))}  Width: {_fmt(r.get('dxy_bb_width'), '.4f')}",
        f"  Cross-asset: SPY ROC10 {_fmt(r.get('spy_roc10'), '+.2%') if r.get('spy_roc10') is not None else 'n/a'}  ROC20 {_fmt(r.get('spy_roc20'), '+.2%') if r.get('spy_roc20') is not None else 'n/a'}  HYG ROC10 {_fmt(r.get('hyg_roc10'), '+.2%') if r.get('hyg_roc10') is not None else 'n/a'}",
        "",
        "Signals",
    ]

    sig = r.get("signals", {})
    bd = r.get("score_breakdown", {})
    signal_rows = [
        ("breakout_60d",            "60d breakout",           bd.get("breakout_60d", 0)),
        ("breakout_90d",            "90d breakout",           bd.get("breakout_90d", 0)),
        ("breakout_confirmed_2of3", "Confirmed breakout 2/3", 0),
        ("above_sma20_and_sma50",   "Above SMA20 & SMA50",    bd.get("above_sma20_and_sma50", 0)),
        ("sma20_above_sma50",       "SMA20 > SMA50",          bd.get("sma20_above_sma50", 0)),
        ("roc10_above_1pct",        "ROC10 > 1%",             bd.get("roc10_above_1pct", 0)),
        ("roc20_above_2pct",        "ROC20 > 2%",             bd.get("roc20_above_2pct", 0)),
        ("zscore_above_1_5",        "Z-score > 1.5",          bd.get("zscore_above_1_5", 0)),
        ("atr_adjusted_breakout",   "ATR-adjusted breakout",  bd.get("atr_adjusted_breakout", 0)),
        ("adx_trending",            "ADX trending (>25)",     bd.get("adx_trending", 0)),
        ("bb_breakout",             "BB breakout + expanding", 0),
        ("dxy_spy_divergence",      "DXY/SPY divergence",     bd.get("dxy_spy_divergence", 0)),
        ("dxy_hyg_confirmed",       "HYG confirms DXY",       bd.get("dxy_hyg_confirmed", 0)),
    ]
    for key, label, pts in signal_rows:
        val = sig.get(key)
        if val is True:
            icon = "✅"
        elif val is False:
            icon = "❌"
        else:
            icon = "❓"
        pts_str = f"  +{pts}" if pts > 0 else ""
        lines.append(f"  {icon} {label:<30}{pts_str}")

    lines += [
        "",
        "Alerts",
        f"  Breakout Warning:      {'YES ⚠️' if r.get('breakout_warning') else 'no'}",
        f"  Equity Risk Confirmed: {'YES \U0001f6a8' if r.get('dxy_equity_risk_confirmed') else 'no'}",
    ]

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
    parser.add_argument(
        "--dxy-only", action="store_true",
        help="Output DXY signals only (skips HYG, SPY, VIX top-line classification)"
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

    if args.dxy_only:
        # Fetch SPY and HYG closes (needed for cross-asset signals)
        spy_closes = []
        hyg_closes = []
        try:
            spy_pairs = source.fetch("SPY", trading_day)
            spy_closes = [p[1] for p in spy_pairs]
        except RuntimeError:
            pass
        try:
            hyg_pairs = source.fetch("HYG", trading_day)
            hyg_closes = [p[1] for p in hyg_pairs]
        except RuntimeError:
            pass

        # Fetch DXY OHLC
        dxy_ohlc = []
        try:
            dxy_ohlc = source.fetch_ohlc("DX-Y.NYB", trading_day)
        except RuntimeError as e:
            result = {"error": str(e), "bearish": None, "dxy_equity_risk_score": None}
            if args.json:
                print(json.dumps({
                    "target_date": str(target_date),
                    "trading_day": str(trading_day),
                    "dxy": result,
                }, indent=2))
            else:
                print(format_dxy_output(trading_day, result))
            return

        result = compute_dxy_score(dxy_ohlc, spy_closes, hyg_closes)

        if args.json:
            print(json.dumps({
                "target_date": str(target_date),
                "trading_day": str(trading_day),
                "dxy": result,
            }, indent=2))
        else:
            print(format_dxy_output(trading_day, result))
        return

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
