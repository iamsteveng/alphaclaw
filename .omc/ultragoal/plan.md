# Ultragoal: US Market Risk Score

**Created:** 2026-05-20T12:29:20.000Z  
**Claude /goal mode:** aggregate  
**Aggregate objective:** US Market Risk Score skill fully working in OpenClaw local container — agent interprets date prompts ("today" / "last monday"), fetches Yahoo Finance data via browser, runs scoring script, and returns a risk-on / neutral / caution / risk-off classification with factor breakdown.

---

## Factors

| # | Ticker | Signal Name | Default Rule |
|---|--------|-------------|--------------|
| 1 | $DXY | Dollar breakout | price > 20-day MA AND 5-day change > +0.5% → bearish for equities |
| 2 | $HYG | HY bond breakdown | price < 20-day MA AND 5-day change < -0.3% → risk-off leading indicator |
| 3 | $SPY | SPY momentum fade | RSI(14) < 55 OR price < 10-day MA → caution |
| 4 | $VIX | VIX at support | VIX < 18 → complacency, not ideal to go long |

**Classification thresholds** (0 = all bullish, 4 = all bearish signals):
- 0 signals bearish → **Risk On**
- 1 signal bearish → **Neutral**
- 2 signals bearish → **Caution**
- 3–4 signals bearish → **Risk Off**

Thresholds and rules are tunable in story G001 before implementation.

---

## Stories

### G001 — Design & Scoring Algorithm
**Objective:** Lock down quantitative rules for all 4 factors, scoring weights, and risk classification thresholds. Produce a `scoring-spec.md` that the script in G003 will implement exactly.  
**Acceptance:** `scoring-spec.md` committed with clear per-factor rules, scoring table, and classification bands.

### G002 — Browser Data Fetcher (switchable source)
**Objective:** Build an OpenClaw agent skill (in the openclaw-dev workspace) that fetches close price + relevant moving-average / RSI data for $DXY, $HYG, $SPY, $VIX from Yahoo Finance via browser for a given date. Wrap behind a `DataSource` interface so the source can be swapped (e.g., to a finance API) without touching the scoring logic.  
**Acceptance:** Skill callable with `{ tickers, date }` → returns structured JSON of price + indicator data. Browser fetch verified for both "today" and a specific past date.

### G003 — Scoring Calculation Script
**Objective:** Build a standalone calculation script (Python or JS) that takes the structured data from G002 and applies the rules from `scoring-spec.md` to produce: per-factor signal (bullish/bearish), composite score, and final classification (risk-on / neutral / caution / risk-off).  
**Acceptance:** Script runnable standalone with fixture data; outputs match expected classifications for at least 3 known market scenarios.

### G004 — Agent Prompt Integration
**Objective:** Wire G002 + G003 into OpenClaw so the main agent responds to natural-language prompts like "give me the US market risk score today" or "give me the US market risk score last monday". Agent resolves the date, calls the data fetcher, runs the scoring script, and replies with a formatted breakdown.  
**Acceptance:** Agent correctly interprets at least two prompt phrasings ("today", named day), returns classification + factor table.

### G005 — Local Container End-to-End Test
**Objective:** Run the full pipeline in the OpenClaw local Docker container (localhost:3001). Verify a live "today" score and a historical date score both return sensible results. Note any data gaps (weekends, market holidays).  
**Acceptance:** Two test runs captured (today + one past date), output shows correct format, no unhandled errors.

---

## Quality Gate (final story only)
- [ ] ai-slop-cleaner pass on any generated code
- [ ] Verification: agent prompt → correct output in container
- [ ] Code review: scoring logic, data source abstraction, prompt parsing
