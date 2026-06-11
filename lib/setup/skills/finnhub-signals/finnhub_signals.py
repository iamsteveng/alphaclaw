#!/usr/bin/env python3
"""
Finnhub Signals — real-time price, technicals, fundamentals, analyst data,
news, and sentiment for a stock ticker via the Finnhub free-tier API.

Usage:
  python3 finnhub_signals.py AAPL
  python3 finnhub_signals.py --ticker AAPL
  python3 finnhub_signals.py AAPL --json
  python3 finnhub_signals.py AAPL --section price
  python3 finnhub_signals.py AAPL --section tech
  python3 finnhub_signals.py AAPL --section analyst
  python3 finnhub_signals.py AAPL --section news
  python3 finnhub_signals.py AAPL --section all   (default)

Requires FINNHUB_API_KEY environment variable.
"""
import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BASE_URL = "https://finnhub.io/api/v1"

SECTIONS = ("price", "tech", "analyst", "news", "all")


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------

def _get(path: str, params: dict, api_key: str) -> dict | list | None:
    """Make a GET request to the Finnhub API. Returns parsed JSON or None on error."""
    params["token"] = api_key
    qs = urllib.parse.urlencode(params)
    url = f"{BASE_URL}{path}?{qs}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "finnhub-signals/1.0",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                return None
            return json.loads(resp.read())
    except (urllib.error.HTTPError, urllib.error.URLError,
            TimeoutError, json.JSONDecodeError, ValueError):
        return None


def _last(arr):
    """Return last element of a list, or None if empty/None."""
    if arr and len(arr) > 0:
        return arr[-1]
    return None


# ---------------------------------------------------------------------------
# Data fetching
# ---------------------------------------------------------------------------

def fetch_all(ticker: str, api_key: str) -> dict:
    """Fetch all Finnhub endpoints for ticker. Returns raw data dict."""
    today = datetime.date.today()
    ts_to = int(datetime.datetime(today.year, today.month, today.day,
                                  23, 59, 59).timestamp())
    date_90d_ago = today - datetime.timedelta(days=90)
    ts_from = int(datetime.datetime(date_90d_ago.year, date_90d_ago.month,
                                    date_90d_ago.day, 0, 0, 0).timestamp())
    date_90d_out = today + datetime.timedelta(days=90)

    data = {}

    # 1. Quote
    data["quote"] = _get("/quote", {"symbol": ticker}, api_key)

    # 2. Company profile
    data["profile"] = _get("/stock/profile2", {"symbol": ticker}, api_key)

    # 3. Fundamentals / metrics
    data["metrics"] = _get("/stock/metric", {"symbol": ticker, "metric": "all"}, api_key)

    # 4. Analyst recommendations
    data["recommendations"] = _get("/stock/recommendation", {"symbol": ticker}, api_key)

    # 6. Company news (last 7 days)
    date_7d_ago = today - datetime.timedelta(days=7)
    data["news"] = _get("/company-news", {
        "symbol": ticker,
        "from": date_7d_ago.isoformat(),
        "to": today.isoformat(),
    }, api_key)

    # 7. Earnings calendar
    data["earnings"] = _get("/calendar/earnings", {
        "symbol": ticker,
        "from": today.isoformat(),
        "to": date_90d_out.isoformat(),
    }, api_key)

    return data


# ---------------------------------------------------------------------------
# Data extraction helpers
# ---------------------------------------------------------------------------

def _safe_float(obj, key, default=None):
    if obj is None:
        return default
    v = obj.get(key)
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def extract_price(data: dict) -> dict:
    q = data.get("quote") or {}
    return {
        "current":    _safe_float(q, "c"),
        "open":       _safe_float(q, "o"),
        "high":       _safe_float(q, "h"),
        "low":        _safe_float(q, "l"),
        "prev_close": _safe_float(q, "pc"),
        "change_pct": _safe_float(q, "dp"),
        "change":     _safe_float(q, "d"),
    }


def extract_profile(data: dict) -> dict:
    p = data.get("profile") or {}
    return {
        "name":       p.get("name"),
        "industry":   p.get("finnhubIndustry"),
        "market_cap": _safe_float(p, "marketCapitalization"),  # in millions
    }


def extract_metrics(data: dict) -> dict:
    m = (data.get("metrics") or {}).get("metric") or {}
    return {
        "week52_high":      _safe_float(m, "52WeekHigh"),
        "week52_low":       _safe_float(m, "52WeekLow"),
        "beta":             _safe_float(m, "beta"),
        "pe":               _safe_float(m, "peBasicExclExtraTTM"),
        "pb":               _safe_float(m, "pbAnnual"),
        "ps":               _safe_float(m, "psAnnual"),
        "gross_margin":     _safe_float(m, "grossMarginTTM"),
        "net_margin":       _safe_float(m, "netProfitMarginTTM"),
    }


def extract_recommendations(data: dict) -> dict:
    recs = data.get("recommendations")
    if not recs or len(recs) == 0:
        return {}
    r = recs[0]
    return {
        "strong_buy":   int(r.get("strongBuy") or 0),
        "buy":          int(r.get("buy") or 0),
        "hold":         int(r.get("hold") or 0),
        "sell":         int(r.get("sell") or 0),
        "strong_sell":  int(r.get("strongSell") or 0),
        "period":       r.get("period"),
    }


def _analyst_consensus(rec: dict) -> str:
    if not rec:
        return "Unknown"
    sb = rec.get("strong_buy", 0)
    b  = rec.get("buy", 0)
    h  = rec.get("hold", 0)
    s  = rec.get("sell", 0)
    ss = rec.get("strong_sell", 0)
    bullish = sb + b
    bearish = s + ss
    total = bullish + h + bearish
    if total == 0:
        return "Unknown"
    bull_pct = bullish / total
    bear_pct = bearish / total
    if sb > b and bull_pct >= 0.5:
        return "Strong Buy"
    if bull_pct >= 0.5:
        return "Buy"
    if bear_pct >= 0.5:
        return "Sell"
    if bull_pct > bear_pct and bull_pct >= 0.3:
        return "Hold"
    return "Mixed"


def extract_news(data: dict) -> list:
    items = data.get("news") or []
    if not isinstance(items, list):
        return []
    result = []
    for item in items:
        if not isinstance(item, dict):
            continue
        ts = item.get("datetime")
        try:
            date_str = datetime.datetime.fromtimestamp(ts).strftime("%b %d") if ts else None
        except (TypeError, ValueError, OSError):
            date_str = None
        result.append({
            "headline": item.get("headline"),
            "source":   item.get("source"),
            "datetime": ts,
            "date":     (datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
                         if ts else None),
            "date_fmt": date_str,
        })
    # Sort descending by datetime, take top 5
    result.sort(key=lambda x: x.get("datetime") or 0, reverse=True)
    return result[:5]


def extract_earnings(data: dict) -> dict:
    today = datetime.date.today()
    cal = (data.get("earnings") or {}).get("earningsCalendar") or []
    future = []
    for entry in cal:
        d_str = entry.get("date")
        if not d_str:
            continue
        try:
            d = datetime.date.fromisoformat(d_str)
        except ValueError:
            continue
        if d >= today:
            future.append(d)
    future.sort()
    if future:
        next_date = future[0]
        days_away = (next_date - today).days
        return {"next_date": str(next_date), "days_away": days_away}
    return {"next_date": None, "days_away": None}


# ---------------------------------------------------------------------------
# Market cap formatting
# ---------------------------------------------------------------------------

def _fmt_market_cap(cap_millions) -> str:
    if cap_millions is None:
        return "n/a"
    cap_billions = cap_millions / 1000.0
    if cap_billions >= 1000:
        return f"${cap_billions / 1000:.2f}T"
    return f"${cap_billions:.2f}B"


def _market_cap_billions(cap_millions) -> float | None:
    if cap_millions is None:
        return None
    return round(cap_millions / 1000.0, 4)


# ---------------------------------------------------------------------------
# Human-readable output
# ---------------------------------------------------------------------------

def _pct(v, decimals=2) -> str:
    if v is None:
        return "n/a"
    return f"{v:+.{decimals}f}%"


def _price(v, decimals=2) -> str:
    if v is None:
        return "n/a"
    return f"${v:.{decimals}f}"


def _val(v, fmt=".2f") -> str:
    if v is None:
        return "n/a"
    return format(v, fmt)


def format_human(ticker: str, section: str,
                 price: dict, profile: dict, metrics: dict,
                 rec: dict, news: list, earnings: dict) -> str:
    lines = []

    name = profile.get("name") or ticker
    industry = profile.get("industry") or "Unknown"
    header = f"{ticker} — {name} | {industry}"
    lines.append(header)
    lines.append("=" * min(len(header), 50))
    lines.append("")

    show_all = section == "all"

    # --- PRICE ---
    if show_all or section == "price":
        current = price.get("current")
        chg_pct = price.get("change_pct")
        chg     = price.get("change")
        prev    = price.get("prev_close")
        w52h    = metrics.get("week52_high")
        w52l    = metrics.get("week52_low")
        beta    = metrics.get("beta")
        cap_m   = profile.get("market_cap")

        chg_str = ""
        if chg_pct is not None and chg is not None:
            sign = "+" if chg >= 0 else "-"
            chg_str = f"({chg_pct:+.2f}%,  {sign}${abs(chg):.2f})"

        lines.append("PRICE")
        lines.append(f"Current:    {_price(current, 2)}  {chg_str}")
        lines.append(
            f"Open:       {_price(price.get('open'), 2)}"
            f"   High: {_price(price.get('high'), 2)}"
            f"   Low: {_price(price.get('low'), 2)}"
        )

        w52_str = "n/a"
        if w52l is not None and w52h is not None:
            w52_str = f"${w52l:.2f} – ${w52h:.2f}"
        lines.append(
            f"Prev Close: {_price(prev, 2)}"
            f"   52W:  {w52_str}"
        )
        lines.append(
            f"Market Cap: {_fmt_market_cap(cap_m)}"
            f"   Beta: {_val(beta, '.2f')}"
        )
        lines.append("")

    # --- TECHNICALS / S/R (Finnhub Premium only) ---
    if show_all or section == "tech":
        lines.append("TECHNICALS / SUPPORT & RESISTANCE")
        lines.append("  [requires Finnhub Premium — /indicator and /scan/support-resistance not on free tier]")
        lines.append("")

    # --- ANALYST ---
    if show_all or section == "analyst":
        sb      = rec.get("strong_buy", 0)
        b       = rec.get("buy", 0)
        h       = rec.get("hold", 0)
        s       = rec.get("sell", 0)
        ss      = rec.get("strong_sell", 0)
        consensus = _analyst_consensus(rec)

        lines.append("ANALYST CONSENSUS")
        if rec:
            lines.append(
                f"Strong Buy: {sb}  Buy: {b}  Hold: {h}"
                f"  Sell: {s}  Strong Sell: {ss}"
            )
            lines.append(f"→ [{consensus}] consensus")
        else:
            lines.append("[data unavailable]")

        lines.append("")

    # --- NEWS ---
    if show_all or section == "news":
        lines.append("NEWS  (last 7 days)")
        if news:
            for item in news:
                hl  = item.get("headline") or "(no headline)"
                src = item.get("source") or ""
                dt  = item.get("date_fmt") or ""
                src_dt = "  ".join(x for x in [src, dt] if x)
                lines.append(f"• {hl} — {src_dt}" if src_dt else f"• {hl}")
        else:
            lines.append("[no news available]")
        lines.append("")

    # --- EARNINGS ---
    if show_all or section == "analyst":
        next_date  = earnings.get("next_date")
        days_away  = earnings.get("days_away")

        lines.append("EARNINGS")
        if next_date:
            lines.append(f"Next earnings: {next_date}  ({days_away} days)")
        else:
            lines.append("No upcoming earnings found in next 90 days")
        lines.append("")

    # --- FUNDAMENTALS ---
    if show_all or section == "price":
        pe = metrics.get("pe")
        pb = metrics.get("pb")
        ps = metrics.get("ps")
        gm = metrics.get("gross_margin")
        nm = metrics.get("net_margin")

        lines.append("FUNDAMENTALS")
        if any(v is not None for v in [pe, pb, ps]):
            lines.append(
                f"P/E: {_val(pe, '.1f')}"
                f"   P/B: {_val(pb, '.1f')}"
                f"   P/S: {_val(ps, '.1f')}"
            )
        else:
            lines.append("[data unavailable]")

        if gm is not None or nm is not None:
            lines.append(
                f"Gross Margin: {_val(gm, '.1f')}%"
                f"   Net Margin: {_val(nm, '.1f')}%"
            )

        lines.append("")

    return "\n".join(lines).rstrip()


# ---------------------------------------------------------------------------
# JSON output
# ---------------------------------------------------------------------------

def build_json_output(ticker: str,
                      price: dict, profile: dict, metrics: dict,
                      rec: dict, news: list, earnings: dict) -> dict:
    cap_m = profile.get("market_cap")
    consensus = _analyst_consensus(rec)

    def _r(v, d=4):
        return round(v, d) if v is not None else None

    news_out = []
    for item in news:
        news_out.append({
            "headline": item.get("headline"),
            "source":   item.get("source"),
            "date":     item.get("date"),
        })

    return {
        "ticker":              ticker,
        "name":                profile.get("name"),
        "industry":            profile.get("industry"),
        "price": {
            "current":    _r(price.get("current"), 4),
            "open":       _r(price.get("open"), 4),
            "high":       _r(price.get("high"), 4),
            "low":        _r(price.get("low"), 4),
            "prev_close": _r(price.get("prev_close"), 4),
            "change_pct": _r(price.get("change_pct"), 4),
            "change":     _r(price.get("change"), 4),
        },
        "market_cap_billions": _market_cap_billions(cap_m),
        "beta":                _r(metrics.get("beta"), 4),
        "week52": {
            "high": _r(metrics.get("week52_high"), 4),
            "low":  _r(metrics.get("week52_low"), 4),
        },
        "technicals":         None,
        "support_resistance": None,
        "analyst": {
            "strong_buy":    rec.get("strong_buy"),
            "buy":           rec.get("buy"),
            "hold":          rec.get("hold"),
            "sell":          rec.get("sell"),
            "strong_sell":   rec.get("strong_sell"),
            "consensus":     consensus,
        },
        "news": news_out,
        "sentiment":           None,
        "earnings_next":       earnings.get("next_date"),
        "earnings_days_away":  earnings.get("days_away"),
        "fundamentals": {
            "pe":              _r(metrics.get("pe"), 4),
            "pb":              _r(metrics.get("pb"), 4),
            "ps":              _r(metrics.get("ps"), 4),
            "gross_margin_pct": _r(metrics.get("gross_margin"), 4),
            "net_margin_pct":  _r(metrics.get("net_margin"), 4),
        },
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Finnhub Signals — real-time price, technicals, fundamentals, "
                    "analyst data, news, and sentiment for a stock ticker."
    )
    parser.add_argument(
        "ticker_pos", nargs="?", metavar="TICKER",
        help="Stock ticker symbol (positional)"
    )
    parser.add_argument(
        "--ticker", "-t", default=None,
        help="Stock ticker symbol (named)"
    )
    parser.add_argument(
        "--json", action="store_true",
        help="Output machine-readable JSON"
    )
    parser.add_argument(
        "--section", choices=SECTIONS, default="all",
        help="Output section filter: price|tech|analyst|news|all (default: all)"
    )
    args = parser.parse_args()

    ticker = args.ticker or args.ticker_pos
    if not ticker:
        parser.print_help(sys.stderr)
        sys.exit(1)
    ticker = ticker.upper().strip()

    api_key = os.environ.get("FINNHUB_API_KEY", "").strip()
    if not api_key:
        print(
            "Error: FINNHUB_API_KEY environment variable is not set.\n"
            "Get a free API key at https://finnhub.io/register",
            file=sys.stderr,
        )
        sys.exit(1)

    raw = fetch_all(ticker, api_key)

    price    = extract_price(raw)
    profile  = extract_profile(raw)
    metrics  = extract_metrics(raw)
    rec      = extract_recommendations(raw)
    news     = extract_news(raw)
    earnings = extract_earnings(raw)

    if args.json:
        out = build_json_output(ticker, price, profile, metrics, rec, news, earnings)
        print(json.dumps(out, indent=2))
    else:
        text = format_human(ticker, args.section, price, profile, metrics, rec, news, earnings)
        print(text)


if __name__ == "__main__":
    main()
