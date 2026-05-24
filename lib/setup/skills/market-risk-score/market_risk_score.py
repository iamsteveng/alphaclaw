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

    def fetch_1y(self, symbol: str, target_date: datetime.date) -> list:
        """Return up to 1 year of [(date, close), ...]. Override for sources with extended history."""
        return self.fetch(symbol, target_date)


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

    def fetch_1y(self, symbol: str, target_date: datetime.date) -> list:
        """Fetch 1-year close-only data (needed for SMA200)."""
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
            closes_data = quotes[0].get("close", [])
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Failed to parse response for {symbol}: {e}")
        pairs = []
        for ts, c in zip(timestamps, closes_data):
            if c is None:
                continue
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
# Shared indicators — close-only, used by HYG / SPY / VIX scoring
# ---------------------------------------------------------------------------

def rsi_n(closes, n=14):
    """RSI with configurable period."""
    if len(closes) < n + 1:
        return None
    deltas = [closes[i] - closes[i - 1] for i in range(len(closes) - n, len(closes))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [max(-d, 0.0) for d in deltas]
    avg_gain = sum(gains) / n
    avg_loss = sum(losses) / n
    if avg_loss == 0 and avg_gain == 0:
        return 50.0
    if avg_loss == 0:
        return 100.0
    return 100.0 - (100.0 / (1.0 + avg_gain / avg_loss))


def ema_series(values, n):
    """EMA series (length = len(values) - n + 1)."""
    if len(values) < n:
        return []
    k = 2.0 / (n + 1)
    result = [sum(values[:n]) / n]
    for v in values[n:]:
        result.append(v * k + result[-1] * (1 - k))
    return result


def compute_macd(closes):
    """Returns (hist_last, hist_5d_slope) or (None, None)."""
    if len(closes) < 35:
        return None, None
    ema12 = ema_series(closes, 12)
    ema26 = ema_series(closes, 26)
    offset = len(ema12) - len(ema26)
    macd_line = [a - b for a, b in zip(ema12[offset:], ema26)]
    if len(macd_line) < 9:
        return None, None
    signal = ema_series(macd_line, 9)
    off2 = len(macd_line) - len(signal)
    hist = [m - s for m, s in zip(macd_line[off2:], signal)]
    slope = (hist[-1] - hist[-6]) if len(hist) >= 6 else None
    return hist[-1], slope


def hist_volatility(closes, n=20):
    """Annualized close-to-close historical volatility (percentage)."""
    import math
    if len(closes) < n + 1:
        return None
    window = closes[-(n + 1):]
    log_rets = [math.log(window[i] / window[i - 1]) for i in range(1, n + 1)]
    mean_r = sum(log_rets) / n
    variance = sum((r - mean_r) ** 2 for r in log_rets) / (n - 1)
    return variance ** 0.5 * (252 ** 0.5) * 100


def bollinger_pct_b(closes, n=20, k=2):
    """%B: 0 = at lower band, 1 = at upper band."""
    mid, upper, lower = bollinger_bands(closes, n, k)
    if upper is None or (upper - lower) == 0:
        return None
    return (closes[-1] - lower) / (upper - lower)


def drawdown_from_high(closes, n):
    """Current close vs n-day rolling high (negative fraction = below peak)."""
    if len(closes) < n:
        return None
    peak = max(closes[-n:])
    return (closes[-1] - peak) / peak if peak != 0 else None


def sma_slope(closes, n, lookback=10):
    """(SMA_now - SMA_lookback_days_ago) / lookback — positive = rising."""
    if len(closes) < n + lookback:
        return None
    sma_now = sma(closes, n)
    sma_past = sma(closes[:-lookback], n)
    if sma_now is None or sma_past is None:
        return None
    return (sma_now - sma_past) / lookback


def count_consecutive_up(values):
    """Count consecutive days the series increased."""
    count = 0
    for i in range(len(values) - 1, 0, -1):
        if values[i] > values[i - 1]:
            count += 1
        else:
            break
    return count


def count_days_above_sma(closes, n, max_check=20):
    """Count consecutive closing days where close > SMA-n (up to max_check days back)."""
    count = 0
    limit = max(len(closes) - max_check - 1, n - 1)
    for i in range(len(closes) - 1, limit, -1):
        window = closes[i - n + 1:i + 1]
        if len(window) < n:
            break
        if closes[i] > sum(window) / n:
            count += 1
        else:
            break
    return count


def rolling_pearson_corr(x, y, n=10):
    """Pearson correlation of pct-changes over last n closes of x and y."""
    if len(x) < n + 1 or len(y) < n + 1:
        return None
    dx = [(x[i] - x[i - 1]) / x[i - 1] for i in range(len(x) - n, len(x)) if x[i - 1] != 0]
    dy = [(y[i] - y[i - 1]) / y[i - 1] for i in range(len(y) - n, len(y)) if y[i - 1] != 0]
    if len(dx) < 3 or len(dy) < 3 or len(dx) != len(dy):
        return None
    n2 = len(dx)
    mx, my = sum(dx) / n2, sum(dy) / n2
    cov = sum((dx[i] - mx) * (dy[i] - my) for i in range(n2)) / n2
    sx = (sum((v - mx) ** 2 for v in dx) / n2) ** 0.5
    sy = (sum((v - my) ** 2 for v in dy) / n2) ** 0.5
    if sx == 0 or sy == 0:
        return None
    return cov / (sx * sy)


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
# HYG score computation
# ---------------------------------------------------------------------------

_HYG_MIN_BARS = 20


def compute_hyg_score(hyg_closes, spy_closes):
    """Compute HYG credit-stress score (0-10). Optimised for leading SPY-drop detection."""
    if len(hyg_closes) < _HYG_MIN_BARS:
        return {
            "error": f"Insufficient HYG data: {len(hyg_closes)} bars, need ≥{_HYG_MIN_BARS}",
            "bearish": None, "hyg_risk_score": None,
        }

    closes = hyg_closes
    current = closes[-1]

    s10  = sma(closes, 10)
    s20  = sma(closes, 20)
    s50  = sma(closes, 50) if len(closes) >= 50 else None
    rsi  = rsi14(closes)
    roc10 = return_n_days(closes, 10)
    roc20 = return_n_days(closes, 20) if len(closes) > 20 else None
    z_n  = min(63, len(closes))
    z63  = zscore_n(closes, z_n)
    pct_b = bollinger_pct_b(closes, 20)

    # 20-day normalised HYG-vs-SPY divergence (percentage points)
    hyg_spy_div = None
    if len(spy_closes) > 20 and len(closes) > 20:
        h_ref, s_ref = closes[-21], spy_closes[-21]
        if h_ref and s_ref:
            hyg_spy_div = ((closes[-1] / h_ref - 1) - (spy_closes[-1] / s_ref - 1)) * 100

    sig = {
        "z_score_extreme":      z63 is not None and z63 <= -2.0,
        "z_score_elevated":     z63 is not None and -2.0 < z63 <= -1.0,
        "hyg_spy_div_severe":   hyg_spy_div is not None and hyg_spy_div < -5.0,
        "hyg_spy_div_moderate": hyg_spy_div is not None and -5.0 <= hyg_spy_div < -3.0,
        "roc10_severe":         roc10 is not None and roc10 < -0.015,
        "roc10_mild":           roc10 is not None and -0.015 <= roc10 < -0.005,
        "below_sma20_sma50":    s20 is not None and s50 is not None and current < s20 and current < s50,
        "below_sma20_only":     s20 is not None and current < s20 and (s50 is None or current >= s50),
        "rsi_danger_zone":      rsi is not None and 30 <= rsi < 45,
        "sma10_lt_sma20":       s10 is not None and s20 is not None and s10 < s20,
        "roc20_negative":       roc20 is not None and roc20 < -0.025,
        "pct_b_breakdown":      pct_b is not None and pct_b < 0.0,
        "sma20_lt_sma50":       s20 is not None and s50 is not None and s20 < s50,
    }

    bd = {
        "z_score":         2 if sig["z_score_extreme"] else (1 if sig["z_score_elevated"] else 0),
        "hyg_spy_div":     2 if sig["hyg_spy_div_severe"] else (1 if sig["hyg_spy_div_moderate"] else 0),
        "roc10":           2 if sig["roc10_severe"] else (1 if sig["roc10_mild"] else 0),
        "sma_position":    2 if sig["below_sma20_sma50"] else (1 if sig["below_sma20_only"] else 0),
        "rsi_danger":      1 if sig["rsi_danger_zone"] else 0,
        "sma10_lt_sma20":  1 if sig["sma10_lt_sma20"] else 0,
        "roc20":           1 if sig["roc20_negative"] else 0,
        "pct_b":           1 if sig["pct_b_breakdown"] else 0,
        "sma20_lt_sma50":  1 if sig["sma20_lt_sma50"] else 0,
    }
    score = min(sum(bd.values()), 10)

    if score <= 2:
        risk_label = "No meaningful credit stress"
    elif score <= 4:
        risk_label = "Early credit warning"
    elif score <= 6:
        risk_label = "Confirmed credit pressure"
    elif score <= 8:
        risk_label = "Strong credit risk-off signal"
    else:
        risk_label = "Severe credit market stress"

    bearish = score >= 4

    parts = []
    if bd["z_score"] and z63 is not None:       parts.append(f"Z {z63:.1f}")
    if bd["hyg_spy_div"] and hyg_spy_div is not None: parts.append(f"div {hyg_spy_div:+.1f}%")
    if bd["roc10"] and roc10 is not None:        parts.append(f"ROC10 {roc10*100:+.1f}%")
    if bd["sma_position"]:
        parts.append("SMA stack" if sig["below_sma20_sma50"] else "< SMA20")
    if bd["rsi_danger"] and rsi is not None:     parts.append(f"RSI {rsi:.0f}")
    if bd["sma10_lt_sma20"]:                     parts.append("SMA10<SMA20")
    if bd["roc20"] and roc20 is not None:        parts.append(f"ROC20 {roc20*100:+.1f}%")
    if bd["pct_b"] and pct_b is not None:        parts.append(f"BB% {pct_b:.2f}")
    if bd["sma20_lt_sma50"]:                     parts.append("SMA20<SMA50")

    reason = f"{score}/10 {risk_label}"
    if parts:
        reason += " — " + ", ".join(parts)

    def _r(v, d=4):
        return round(v, d) if v is not None else None

    return {
        "close":           _r(current),
        "hyg_risk_score":  score,
        "risk_label":      risk_label,
        "hyg_sma10":       _r(s10),
        "hyg_sma20":       _r(s20),
        "hyg_sma50":       _r(s50),
        "hyg_roc10":       _r(roc10, 6),
        "hyg_roc20":       _r(roc20, 6),
        "hyg_rsi14":       _r(rsi, 2),
        "hyg_zscore":      _r(z63, 4),
        "hyg_pct_b":       _r(pct_b, 4),
        "hyg_spy_div_20d": _r(hyg_spy_div, 4),
        "signals":         sig,
        "score_breakdown": bd,
        "bearish":         bearish,
        "reason":          reason,
    }


# ---------------------------------------------------------------------------
# SPY score computation
# ---------------------------------------------------------------------------

_SPY_MIN_BARS = 20


def compute_spy_score(spy_closes):
    """Compute SPY bearishness score (0-10). Optimised for 5%+ 14-day forward drop prediction."""
    if len(spy_closes) < _SPY_MIN_BARS:
        return {
            "error": f"Insufficient SPY data: {len(spy_closes)} bars, need ≥{_SPY_MIN_BARS}",
            "bearish": None, "spy_risk_score": None,
        }

    closes = spy_closes
    current = closes[-1]

    s20  = sma(closes, 20)
    s50  = sma(closes, 50)  if len(closes) >= 50  else None
    s200 = sma(closes, 200) if len(closes) >= 200 else None
    rsi  = rsi14(closes)
    roc5  = return_n_days(closes, 5)
    roc10 = return_n_days(closes, 10)
    roc20 = return_n_days(closes, 20) if len(closes) > 20 else None
    z20  = zscore_n(closes, 20)
    macd_hist, macd_slope = compute_macd(closes)
    hv20  = hist_volatility(closes, 20)
    hv20_prior = hist_volatility(closes[:-5], 20) if len(closes) > 25 else None
    dd20  = drawdown_from_high(closes, 20)
    slope50  = sma_slope(closes, 50,  10) if len(closes) >= 60  else None
    slope200 = sma_slope(closes, 200, 20) if len(closes) >= 220 else None

    # Bollinger expansion downward
    bb_mid, bb_upper, bb_lower = bollinger_bands(closes, 20)
    bbw_now = (bb_upper - bb_lower) / bb_mid if bb_mid else None
    bbw_5d  = None
    if len(closes) >= 25:
        bm5, bu5, bl5 = bollinger_bands(closes[:-5], 20)
        bbw_5d = (bu5 - bl5) / bm5 if bm5 else None
    bb_exp_down = (bbw_now is not None and bbw_5d is not None and
                   bbw_now > bbw_5d and bb_lower is not None and current < bb_lower)

    # Bearish trend context: SMA200 declining OR SMA50 declining
    bearish_ctx = (s200 is not None and current < s200) or (slope50 is not None and slope50 < 0)

    sig = {
        "below_sma200_neg_slope": s200 is not None and current < s200 and slope200 is not None and slope200 < 0,
        "below_sma200":           s200 is not None and current < s200 and not (slope200 is not None and slope200 < 0),
        "rsi_bear_zone":          rsi is not None and bearish_ctx and 35 <= rsi <= 55,
        "rsi_late_dist":          rsi is not None and bearish_ctx and 55 < rsi <= 65,
        "macd_hist_bear":         macd_hist is not None and macd_hist < 0 and macd_slope is not None and macd_slope < 0,
        "roc_severe":             (roc20 is not None and roc20 < -0.05) or
                                  (roc5 is not None and roc10 is not None and roc5 < -0.03 and roc10 < -0.025),
        "roc_moderate":           roc5 is not None and roc10 is not None and roc5 < -0.015 and roc10 < -0.02
                                  and not ((roc20 is not None and roc20 < -0.05) or
                                           (roc5 < -0.03 and roc10 < -0.025)),
        "z_danger_zone":          z20 is not None and -2.5 <= z20 <= -1.5,
        "hv_rising":              hv20 is not None and hv20 > 25 and hv20_prior is not None and hv20 > hv20_prior * 1.20,
        "sma50_declining":        slope50 is not None and slope50 < 0,
        "bb_exp_down":            bb_exp_down,
        "drawdown_severe":        dd20 is not None and dd20 < -0.05,
    }

    bd = {
        "sma200":      3 if sig["below_sma200_neg_slope"] else (1 if sig["below_sma200"] else 0),
        "rsi":         2 if sig["rsi_bear_zone"] else (1 if sig["rsi_late_dist"] else 0),
        "macd":        2 if sig["macd_hist_bear"] else 0,
        "roc":         2 if sig["roc_severe"] else (1 if sig["roc_moderate"] else 0),
        "z_score":     1 if sig["z_danger_zone"] else 0,
        "hv_rising":   1 if sig["hv_rising"] else 0,
        "sma50_slope": 1 if sig["sma50_declining"] else 0,
        "bb_down":     1 if sig["bb_exp_down"] else 0,
        "drawdown":    1 if sig["drawdown_severe"] else 0,
    }
    score = min(sum(bd.values()), 10)

    if score <= 2:
        risk_label = "No meaningful SPY pressure"
    elif score <= 4:
        risk_label = "Early equity warning"
    elif score <= 6:
        risk_label = "Confirmed equity weakness"
    elif score <= 8:
        risk_label = "Strong bearish momentum"
    else:
        risk_label = "Severe equity risk-off"

    bearish = score >= 3

    parts = []
    if bd["sma200"]:
        parts.append("< SMA200" + (" ↓" if sig["below_sma200_neg_slope"] else ""))
    if bd["rsi"] and rsi is not None:   parts.append(f"RSI {rsi:.0f}")
    if bd["macd"]:                       parts.append("MACD↓")
    if bd["roc"] and roc20 is not None:  parts.append(f"ROC20 {roc20*100:+.1f}%")
    if bd["z_score"] and z20 is not None: parts.append(f"Z {z20:.1f}")
    if bd["hv_rising"] and hv20 is not None: parts.append(f"HV {hv20:.0f}%↑")
    if bd["sma50_slope"]:               parts.append("SMA50↓")
    if bd["bb_down"]:                   parts.append("BB break↓")
    if bd["drawdown"] and dd20 is not None: parts.append(f"DD {dd20*100:.1f}%")

    reason = f"{score}/10 {risk_label}"
    if parts:
        reason += " — " + ", ".join(parts)

    def _r(v, d=4):
        return round(v, d) if v is not None else None

    return {
        "close":          _r(current),
        "spy_risk_score": score,
        "risk_label":     risk_label,
        "spy_sma20":      _r(s20),
        "spy_sma50":      _r(s50),
        "spy_sma200":     _r(s200),
        "spy_rsi14":      _r(rsi, 2),
        "spy_roc5":       _r(roc5, 6),
        "spy_roc10":      _r(roc10, 6),
        "spy_roc20":      _r(roc20, 6),
        "spy_z20":        _r(z20, 4),
        "spy_macd_hist":  _r(macd_hist, 6),
        "spy_hv20":       _r(hv20, 2),
        "spy_dd20":       _r(dd20, 4),
        "spy_slope50":    _r(slope50, 6),
        "spy_slope200":   _r(slope200, 6),
        "signals":        sig,
        "score_breakdown": bd,
        "bearish":        bearish,
        "reason":         reason,
    }


# ---------------------------------------------------------------------------
# VIX score computation
# ---------------------------------------------------------------------------

_VIX_MIN_BARS = 15


def compute_vix_score(vix_closes, spy_closes):
    """Compute VIX-based equity-risk score (0-10). Higher = more bearish for SPY."""
    if len(vix_closes) < _VIX_MIN_BARS:
        return {
            "error": f"Insufficient VIX data: {len(vix_closes)} bars, need ≥{_VIX_MIN_BARS}",
            "bearish": None, "vix_risk_score": None,
        }

    closes = vix_closes
    current = closes[-1]

    s5  = sma(closes, 5)
    s10 = sma(closes, 10)
    s20 = sma(closes, 20)
    roc5 = return_n_days(closes, 5)
    z_n  = min(63, len(closes))
    z63  = zscore_n(closes, z_n)
    rsi5 = rsi_n(closes, 5)

    # Low-base spike: VIX was < 15 five days ago AND has risen ≥ 20%
    vix_5d_ago = closes[-6] if len(closes) >= 6 else None
    low_base_spike = (vix_5d_ago is not None and vix_5d_ago < 15 and
                      roc5 is not None and roc5 > 0.20)

    # Moderate spike in non-exhausted zone: 5d ROC in [30%, 50%], VIX < 30
    moderate_spike = (roc5 is not None and 0.30 <= roc5 <= 0.50 and current < 30)

    # Z-score elevated but not panic (>3 → exhaustion/contrarian)
    z_elevated = z63 is not None and 1.5 <= z63 <= 3.0

    # Sustained above own SMA20 for 5+ consecutive days
    sustained_above_sma20 = count_days_above_sma(closes, 20, max_check=20) >= 5

    # VIX/SMA10 in moderate displacement zone [1.10, 1.25]
    sma10_ratio = current / s10 if s10 else None
    sma10_moderate = sma10_ratio is not None and 1.10 <= sma10_ratio <= 1.25

    # Absolute level in stressed-not-panic zone [20, 30]
    elevated_not_panic = 20 <= current <= 30

    # VIX–SPY rolling 10-day correlation breakdown (normal ≈ -0.70 to -0.90)
    spy_corr = rolling_pearson_corr(closes, spy_closes, 10) if len(spy_closes) >= 11 else None
    corr_breakdown = spy_corr is not None and spy_corr > -0.40 and current > 14

    # 4+ consecutive VIX up-days while not yet in panic zone
    consec_up_signal = count_consecutive_up(closes) >= 4 and 13 <= current <= 28

    # Spot-VIX contango proxy: SMA20 / SMA5 < 0.95 → near-term spike > medium-term avg
    contango_proxy = s20 / s5 if s5 and s20 else None
    backwardation = contango_proxy is not None and contango_proxy < 0.95

    # RSI5 exhaustion check (> 75 means VIX is overbought → equities near a bottom)
    rsi5_exhausted = rsi5 is not None and rsi5 > 75

    sig = {
        "low_base_spike":        low_base_spike,
        "moderate_spike":        moderate_spike,
        "z_elevated":            z_elevated,
        "sustained_above_sma20": sustained_above_sma20,
        "sma10_moderate":        sma10_moderate,
        "elevated_not_panic":    elevated_not_panic,
        "corr_breakdown":        corr_breakdown,
        "consec_up":             consec_up_signal,
        "backwardation":         backwardation,
        "rsi5_not_exhausted":    rsi5 is not None and 40 <= rsi5 <= 70,
        "rsi5_exhausted":        rsi5_exhausted,
    }

    bd = {
        "low_base_spike":        2 if sig["low_base_spike"] else 0,
        "moderate_spike":        2 if sig["moderate_spike"] else 0,
        "z_elevated":            2 if sig["z_elevated"] else 0,
        "sustained_above_sma20": 2 if sig["sustained_above_sma20"] else 0,
        "sma10_moderate":        1 if sig["sma10_moderate"] else 0,
        "elevated_not_panic":    1 if sig["elevated_not_panic"] else 0,
        "corr_breakdown":        1 if sig["corr_breakdown"] else 0,
        "consec_up":             1 if sig["consec_up"] else 0,
        "backwardation":         1 if sig["backwardation"] else 0,
    }
    # Exhaustion penalty: when RSI5 > 75, VIX momentum is spent → equities may bounce
    if rsi5_exhausted:
        bd["rsi5_exhaustion"] = -1
    score = min(max(sum(bd.values()), 0), 10)

    if score <= 2:
        risk_label = "VIX complacent / no signal"
    elif score <= 4:
        risk_label = "VIX early warning"
    elif score <= 6:
        risk_label = "VIX elevated stress"
    elif score <= 8:
        risk_label = "VIX strong risk-off signal"
    else:
        risk_label = "VIX regime breakdown"

    bearish = score >= 1

    parts = []
    if sig["low_base_spike"] and vix_5d_ago: parts.append(f"spike from {vix_5d_ago:.1f}")
    if sig["moderate_spike"] and roc5:        parts.append(f"ROC5 {roc5*100:+.0f}%")
    if sig["z_elevated"] and z63:             parts.append(f"Z {z63:.1f}")
    if sig["sustained_above_sma20"]:          parts.append("sustained > SMA20")
    if sig["sma10_moderate"] and sma10_ratio: parts.append(f"SMA10 ratio {sma10_ratio:.2f}")
    if sig["elevated_not_panic"]:             parts.append(f"VIX {current:.1f}")
    if sig["corr_breakdown"] and spy_corr:    parts.append(f"corr {spy_corr:.2f}")
    if sig["consec_up"]:                      parts.append(f"{count_consecutive_up(closes)}d up")
    if sig["backwardation"]:                  parts.append("backwardation")
    if rsi5_exhausted and rsi5:               parts.append(f"RSI5 {rsi5:.0f} exhausted")

    reason = f"{score}/10 {risk_label}"
    if parts:
        reason += " — " + ", ".join(parts)

    def _r(v, d=4):
        return round(v, d) if v is not None else None

    return {
        "close":          _r(current),
        "vix_risk_score": score,
        "risk_label":     risk_label,
        "vix_sma5":       _r(s5),
        "vix_sma10":      _r(s10),
        "vix_sma20":      _r(s20),
        "vix_roc5":       _r(roc5, 6),
        "vix_zscore":     _r(z63, 4),
        "vix_rsi5":       _r(rsi5, 2),
        "vix_5d_ago":     _r(vix_5d_ago),
        "vix_spy_corr10": _r(spy_corr, 4),
        "contango_proxy": _r(contango_proxy, 4),
        "sma10_ratio":    _r(sma10_ratio, 4),
        "signals":        sig,
        "score_breakdown": bd,
        "bearish":        bearish,
        "reason":         reason,
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
        elif label == "SPY":
            # SPY uses 1Y data so SMA200 signals are available
            try:
                close_data["SPY"] = source.fetch_1y(symbol, trading_day)
            except RuntimeError as e:
                signals["SPY"] = None
                raw["SPY"] = {"error": str(e)}
                close_data["SPY"] = None
        else:
            try:
                close_data[label] = source.fetch(symbol, trading_day)
            except RuntimeError as e:
                signals[label] = None
                raw[label] = {"error": str(e)}
                close_data[label] = None

    spy_closes = [p[1] for p in close_data.get("SPY") or []]
    hyg_closes = [p[1] for p in close_data.get("HYG") or []]
    vix_closes = [p[1] for p in close_data.get("VIX") or []]

    # Phase B — compute signals

    # DXY: full scoring model (uses short spy/hyg for cross-asset signals)
    if "DXY" not in raw:
        # DXY cross-asset signals use short SPY/HYG windows; pass 3mo-equivalent tail
        spy_short = spy_closes[-63:] if spy_closes else []
        hyg_short = hyg_closes[-63:] if hyg_closes else []
        result = compute_dxy_score(dxy_ohlc, spy_short, hyg_short)
        signals["DXY"] = result["bearish"]
        raw["DXY"] = result

    # HYG: comprehensive credit-stress scoring model
    if "HYG" not in raw:
        pairs = close_data.get("HYG")
        if pairs is None or len(pairs) < _HYG_MIN_BARS:
            signals["HYG"] = None
            raw["HYG"] = {"error": f"Only {len(pairs) if pairs else 0} trading days, need ≥{_HYG_MIN_BARS}"}
        else:
            closes = [p[1] for p in pairs]
            result = compute_hyg_score(closes, spy_closes)
            result["close_date"] = str(pairs[-1][0])
            signals["HYG"] = result["bearish"]
            raw["HYG"] = result

    # SPY: comprehensive bearishness scoring model
    if "SPY" not in raw:
        pairs = close_data.get("SPY")
        if pairs is None or len(pairs) < _SPY_MIN_BARS:
            signals["SPY"] = None
            raw["SPY"] = {"error": f"Only {len(pairs) if pairs else 0} trading days, need ≥{_SPY_MIN_BARS}"}
        else:
            closes = [p[1] for p in pairs]
            result = compute_spy_score(closes)
            result["close_date"] = str(pairs[-1][0])
            signals["SPY"] = result["bearish"]
            raw["SPY"] = result

    # VIX: volatility-regime scoring model
    if "VIX" not in raw:
        pairs = close_data.get("VIX")
        if pairs is None or len(pairs) < _VIX_MIN_BARS:
            signals["VIX"] = None
            raw["VIX"] = {"error": f"Only {len(pairs) if pairs else 0} trading days, need ≥{_VIX_MIN_BARS}"}
        else:
            closes = [p[1] for p in pairs]
            result = compute_vix_score(closes, spy_closes)
            result["close_date"] = str(pairs[-1][0])
            signals["VIX"] = result["bearish"]
            raw["VIX"] = result

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

    _score_key = {
        "DXY": "dxy_equity_risk_score",
        "HYG": "hyg_risk_score",
        "SPY": "spy_risk_score",
        "VIX": "vix_risk_score",
    }
    _bearish_threshold = {"DXY": 7, "HYG": 4, "SPY": 3, "VIX": 1}

    for key in ("DXY", "HYG", "SPY", "VIX"):
        sig = signals.get(key)
        r = raw.get(key, {})
        score = r.get(_score_key[key], 0) or 0
        thresh = _bearish_threshold[key]

        if sig is None:
            si, st = "❓", "Unknown "
            detail = r.get("error", "no data")
        else:
            if score >= thresh:
                si, st = "\U0001f534", "Bearish "
            elif score >= max(thresh - 3, 2):
                si, st = "\U0001f7e1", "Caution "
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
