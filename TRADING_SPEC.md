# Trading Advisor AI Agent — Spec

## Overview

The Trading Advisor is a Claude AI-powered automated trading management system built on top of the OpenClaw platform. It ingests market signals from social media (X/Twitter), generates structured trading plans, tracks live prices, manages risk, and delivers daily reports via Telegram — all orchestrated through scheduled cron jobs that invoke Claude as the reasoning engine.

---

## Architecture

```
X/Twitter Feed
     │
     ▼
X-List Ingest (tweet ingestion) → GBrain (knowledge base)
                                        │
          ┌─────────────────────────────┼──────────────────────────┐
          ▼                             ▼                          ▼
  Watchlist Builder             Market Risk Score           EOD Loop
  (8:00 AM ET)                  (9:35 AM ET)               (4:30 PM ET)
          │                             │                          │
          └──────────────┬──────────────┘                          │
                         ▼                                         │
               Price Report (every 15 min,                         │
               9:30–12:30 PM ET)                                   │
                         │                                         │
                         └───────────────────────────────────────► Telegram
```

**Key components:**
- **OpenClaw Gateway** — routes cron-triggered `agentTurn` payloads to Claude
- **GBrain** — persistent knowledge base; stores plans, scores, learning logs
- **Finnhub** — market data provider (REST quotes + WebSocket real-time trades)
- **Claude (main agent)** — executes all trading logic via natural-language step instructions
- **Telegram** — delivery channel for all reports and alerts

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `FINNHUB_API_KEY` | Finnhub REST/WebSocket API key — required for price data |
| `OPENCLAW_DIR` | Root workspace directory (default: `~/.openclaw`) |

The Finnhub API key is entered via the Trading Advisor card in the UI and saved as a server-side env var.

---

## Cron Jobs

All four jobs run on **weekdays only** in the **America/New_York** timezone.

### 1. Watchlist Builder — 8:00 AM ET

**Purpose:** Scans GBrain for recent tweet signals and builds/updates the trading watchlist.

**Steps:**
1. Checks `watchlist/last-run` in GBrain to avoid duplicate runs.
2. Loads all GBrain content and filters for `type: tweet` entries from the last 24 hours.
3. Extracts structured signals from each tweet: ticker, direction (LONG/SHORT), entry price, target price, invalidation price.
4. Applies policy gates:
   - Max 10 active trading plans at any time.
   - Reward-to-risk ratio must be ≥ 2:1.
   - Detects direction conflicts (existing plan in opposite direction).
5. Generates trading plans saved to GBrain at `plans/<TICKER>` with status `pending-confirmation`.
6. Updates `watchlist/current` and `~/.openclaw/finnhub-watchlist.json`.
7. Publishes a Telegram report listing new plans, rejections (with reasons), and conviction alerts.

**Timeout:** 600 seconds

---

### 2. Market Risk Score — 9:35 AM ET

**Purpose:** Computes a composite market risk score to overlay on all trading decisions.

**Steps:**
1. Fetches quotes for SPY, QQQ, and VIXY from the Finnhub REST API.
2. Computes a risk score from 1–5 starting at neutral (3), adjusted by:
   - VIXY change %
   - SPY change %
   - QQQ change %
3. Writes the result to GBrain at `market/risk-YYYY-MM-DD`.
4. Publishes a Telegram report with the score and brief interpretation.

**Timeout:** 120 seconds

---

### 3. Price Report — Every 15 min, 9:30–12:30 PM ET

**Purpose:** Monitors active plans against live prices and alerts on proximity to entry.

**Steps:**
1. Reads `~/.openclaw/finnhub-prices.json` for current price snapshots.
2. Loads all active trading plans from GBrain.
3. Checks each plan: if current price is within **2% of the entry price**, triggers an alert.
4. Publishes a Telegram table with columns: Ticker | Direction | Entry | Current | Distance% | Conviction.

**Timeout:** 120 seconds

---

### 4. EOD Loop — 4:30 PM ET

**Purpose:** End-of-day audit of all plans against the day's price action.

**Steps:**
1. Loads all trading plans (active, closed, and invalidated).
2. For each plan:
   - Checks if the invalidation level was breached (→ marks plan invalidated).
   - Checks if the target was hit (→ marks plan closed/won).
   - Audits conviction calibration vs. actual price movement.
3. Writes a full analysis to GBrain at `learning/YYYY-MM-DD`.
4. Publishes a Telegram summary of the day's outcomes and calibration notes.

**Timeout:** 300 seconds

---

## Supplemental Cron: US Market Risk Score — 9:00 PM HKT (daily)

A separate, standalone cron runs at **21:00 HKT every day** (including weekends). It invokes the main agent with the message `"Give me today US market risk score"` in an isolated session and delivers the result to the configured channel.

This is managed independently via `/api/market-risk-score/*` endpoints and is toggled separately in the UI.

---

## Market Risk Score Skill (`market-risk-score`)

Located at: `src/lib/setup/skills/market-risk-score/`

A Python-based composite scoring engine that computes a **0–5 risk score** from four market factors.

### Factors & Sub-signals

| Factor | Weight | Sub-signals |
|---|---|---|
| DXY (Dollar Index) | High | Z-score, SMA stacks, ROC, ADX, Bollinger Bands, breakout detection |
| HYG (High-Yield Bonds) | High | Same signal suite |
| SPY (S&P 500) | Medium | Same + intraday reversal signal |
| VIX (Volatility) | Medium | Same + term structure |

**Intraday signals added June 2026:**
- **SPY intraday reversal:** `(High - Close) / ATR14 >= 1.0` — detects intraday rejection at highs
- **IWM/SPY breadth divergence:** `IWM 5d ROC < SPY 5d ROC - 0.5pp` — flags narrow leadership

### Score Classification

| Score | Label |
|---|---|
| 0 | Risk On |
| 1 | Neutral |
| 2 | Caution |
| 3–4 | Risk Off |

**Data source:** Yahoo Finance (free, no auth required).

**Usage:**
```bash
python3 market_risk_score.py [--date DATE] [--json] [--dxy-only]
```

A walk-forward backtesting harness (`backtest_market_risk_score.py`) and standalone signal tester (`backtest_new_signals.py`) are included for calibration.

---

## Watchlist Builder Skill (`watchlist-builder`)

Located at: `src/lib/setup/skills/watchlist-builder/SKILL.md`

Procedural documentation (~240 lines) that the main agent follows step-by-step to build the watchlist.

**For each ticker found in recent signals:**
1. Check active plan count (gate: max 10 total).
2. Audit conviction on any existing plan for the ticker.
3. Generate a new trading plan from the signal evidence.
4. Validate reward:risk ≥ 2:1.
5. Apply market risk overlay (lower conviction if risk score is elevated).
6. Save plan to GBrain with `status: pending-confirmation`.

**Confirmation gate:** No plan is activated until Steve explicitly confirms it. The agent publishes the plan as pending and waits.

---

## GBrain Data Structure

All persistent state lives in GBrain (OpenClaw's knowledge base):

| GBrain Path | Contents |
|---|---|
| `watchlist/current` | Active/pending tickers with conviction levels |
| `watchlist/last-run` | ISO timestamp of last watchlist builder run |
| `plans/<TICKER>` | Trading plan YAML with ticker, direction, entry, target, invalidation, rr_ratio, conviction, status |
| `market/risk-YYYY-MM-DD` | Daily market risk score and analysis |
| `learning/YYYY-MM-DD` | EOD calibration notes and audit results |

**Local files:**

| File | Contents |
|---|---|
| `~/.openclaw/finnhub-prices.json` | `{ticker: {open, current, changePct, updatedAt}}` |
| `~/.openclaw/finnhub-watchlist.json` | Array of tickers subscribed for Finnhub polling |

---

## Finnhub Price Integration

### REST Poller (`src/lib/server/finnhub-poller.js`)

- Polls every **5 minutes** during market window: **9:20 AM – 12:40 PM ET**, weekdays only.
- Reads watchlist from `~/.openclaw/finnhub-watchlist.json`.
- Fetches: `https://finnhub.io/api/v1/quote?symbol=TICKER&token=$FINNHUB_API_KEY`
- Writes to `~/.openclaw/finnhub-prices.json`.
- Started automatically on server boot via `src/lib/server/startup.js`.

### WebSocket Tracker (`src/scripts/finnhub-ws.js`)

- Connects to `wss://ws.finnhub.io` for real-time trade stream.
- Reads tickers from GBrain `watchlist/current`.
- Triggers an intraday audit via `claw turn --agent main` if any symbol drops **>5% from session open**.
- Falls back gracefully when not connected.

---

## API Endpoints

### Trading Crons (`/api/trading-crons/*`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/trading-crons/status` | Status of all 4 jobs + Finnhub key presence |
| `POST` | `/api/trading-crons/ensure` | Register all 4 jobs (skips if already registered) |
| `POST` | `/api/trading-crons/run/:name` | Manually trigger a job by name |
| `DELETE` | `/api/trading-crons` | Remove all 4 jobs |

### Market Risk Score (`/api/market-risk-score/*`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/market-risk-score/status` | Check if cron is registered |
| `POST` | `/api/market-risk-score/ensure` | Register the cron |
| `DELETE` | `/api/market-risk-score` | Remove the cron |

---

## UI Components

Located at: `src/lib/public/js/components/cron-tab/`

| Component | Purpose |
|---|---|
| `trading-advisor-card.js` | Main card: 4 cron jobs, Finnhub key input, delivery channel, register/deregister |
| `market-risk-score-card.js` | Standalone card for the 9 PM HKT risk score cron |
| `index.js` | Cron tab root — renders both cards + X-List Ingest card |

---

## Agent Execution Model

Each cron job schedules an `agentTurn` payload via the **OpenClaw Gateway RPC**. The payload contains:
- `agentId: "main"` — routes to the main Claude agent
- `sessionTarget: "isolated"` — creates a fresh isolated session per run
- `delivery.mode: "announce"` — sends output to Telegram
- A numbered step-by-step instruction message that tells Claude exactly what commands to run, what to validate, and what format to output

The instructions are written to be self-contained and non-interactive — Claude does not ask for clarification; it executes deterministically.

---

## Setup

1. Enter your **Finnhub API key** in the Trading Advisor card in the UI.
2. Select a **Telegram delivery channel**.
3. Click **Register** to activate all 4 trading crons.
4. Optionally enable the standalone **Market Risk Score** cron (9 PM HKT daily).

Alternatively, use the setup script:
```bash
src/scripts/setup-trading-crons.sh
```
This auto-detects Telegram delivery from existing alphaclaw sessions and registers crons via `claw cron add`.

---

## Policy Rules Summary

| Rule | Value |
|---|---|
| Max active plans | 10 |
| Min reward:risk ratio | 2:1 |
| Confirmation required | Yes — all new plans start as `pending-confirmation` |
| Market hours (price polling) | 9:20 AM – 12:40 PM ET |
| Intraday drop alert threshold | >5% from session open |
| Entry proximity alert | Within 2% of entry price |
