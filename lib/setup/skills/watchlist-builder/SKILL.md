---
name: watchlist-builder
description: Build and maintain a trading watchlist from GBrain content. Generates trading plans for new tickers, audits conviction on existing ones, enforces policy gates (max plans, conflict detection, RR ≥ 2:1, market risk overlay). Invoke when asked to build the watchlist, generate a trading plan, or audit existing plans. Also triggered by the trading-watchlist-builder cron at 19:30 HKT.
triggers:
  - "build watchlist"
  - "audit watchlist"
---

# Watchlist Builder + Trading Plan Generator

Runs ~19:30 HKT daily (between HK market close and US market open). Reads GBrain for fresh content, processes each ticker, and announces plan proposals to Steve via Telegram. Steve confirms before any plan becomes active.

---

## Step 1 — Fetch inputs

```
1a. Query GBrain for recent content (last 24 hours):
    gbrain query "stock ticker trading signal news" --no-expand
    Focus on pages with type=tweet or type=article, posted within 24h.

1b. Read the current watchlist:
    gbrain get watchlist/current
    Extract active tickers and their conviction levels.

1c. Get the current market risk score.
    Note the classification (Risk On / Neutral / Caution / Risk Off).
```

---

## Step 2 — Process each ticker mentioned in GBrain content

For each ticker symbol found in recent GBrain content:

### 2a — Policy gate: active plan count

Read all pages under `plans/` with `status: active`. Count them.

- If count ≥ 10: skip this ticker entirely. Note it as blocked by cap.
- Continue to next ticker.

### 2b — Classify: new or existing

- **Existing**: a `plans/<TICKER>` page already exists with `status: active` → go to Step 3 (conviction audit)
- **New**: no active plan for this ticker → go to Step 4 (plan generation)

---

## Step 3 — Conviction audit (existing ticker)

Re-evaluate whether the stored conviction still matches the current evidence.

Check all three:
1. **New GBrain content**: does it support or contradict the existing thesis?
2. **Market risk score**: has classification shifted since the plan was created?
3. **Price structure**: read `~/.openclaw/finnhub-prices.json` for current price. Is price still in the valid zone (above invalidation for LONG, below for SHORT)?

If any of the three no longer matches the stored conviction:
- Propose a conviction update: new level + one-line reason
- Do NOT write to GBrain yet — include in the Telegram announcement for Steve to confirm

If all three still support the stored conviction: note "conviction holds" in the announcement.

---

## Step 4 — Plan generation (new ticker)

### 4a — Policy gate: conflict detection

Read `plans/<TICKER>` (any status). If a plan exists with `status: active` in the **opposite direction** to what the new evidence suggests:

> "You have an active [LONG/SHORT] on [TICKER] — new evidence suggests [SHORT/LONG]. Should I close the existing plan first, or skip this one?"

Do NOT generate the new plan. Include this conflict message in the Telegram announcement.

### 4b — Generate the trading plan

Using the GBrain content as evidence:

```
direction: LONG or SHORT (based on evidence sentiment)
entry:        price level where you'd enter (support/resistance, round number, or breakout level)
target:       exit level based on next resistance/support
invalidation: level that proves the thesis wrong

evidence:
  1. [first supporting point from GBrain content]
  2. [second supporting point — price structure or technical level]
  3. [third supporting point — macro or sentiment context]

conviction: 1–5
  5 = all three evidence points strongly align, price at ideal entry
  4 = two points align, one is neutral
  3 = mixed signals but net positive
  2 = weak case, mostly speculative
  1 = very early stage, monitoring only
```

### 4c — Policy gate: reward:risk check

```
RR = (target - entry) / (entry - invalidation)   [for LONG]
RR = (entry - target) / (invalidation - entry)   [for SHORT]
```

- If RR < 2.0: reject the plan. Note the rejection reason in the announcement.
- If RR ≥ 2.0: proceed.

### 4d — Apply market risk overlay

Adjust conviction based on market risk score:
- Risk On: no change
- Neutral: no change
- Caution: lower conviction by 1 (minimum 1)
- Risk Off: lower conviction by 1 (minimum 1) AND flag with ⚠️

### 4e — Save to GBrain as pending

Write to `plans/<TICKER>`:

```yaml
---
type: trading-plan
ticker: <TICKER>
direction: LONG | SHORT
entry: <price>
target: <price>
invalidation: <price>
rr_ratio: <float, 2 decimal places>
conviction: <1-5>
market_risk_at_creation: <Risk On | Neutral | Caution | Risk Off>
status: pending-confirmation
created_at: <ISO-8601>
updated_at: <ISO-8601>
---

## Evidence

1. <point 1>
2. <point 2>
3. <point 3>

## Risk sizing

Regular stock: HK$500 risk per trade
Meme stock: HK$5,000 fixed risk

## Notes

<any additional context>
```

---

## Step 5 — Update watchlist/current

Write a summary of all active + pending tickers to `watchlist/current`:

```yaml
---
type: watchlist
updated_at: <ISO-8601>
---

## Active Tickers

- <TICKER> (conviction: <N>, direction: <LONG|SHORT>)
- ...

## Pending Confirmation

- <TICKER> (conviction: <N>, direction: <LONG|SHORT>)
- ...
```

---

## Step 6 — Write finnhub-watchlist.json

Extract all tickers (active + pending) and write to `~/.openclaw/finnhub-watchlist.json`:

```json
["AAPL", "TSLA", "NVDA"]
```

This file is read by `finnhub-ws.js` to refresh WebSocket subscriptions.

---

## Step 7 — Announce results

End your reply with a summary in this exact format (delivered via Telegram):

```
Watchlist Builder — <date> 19:30 HKT
Market risk: <Risk On | Neutral | Caution | Risk Off>

📋 New plans (pending your confirmation):
✅ <TICKER> [LONG/SHORT] entry <X> target <X> invalidation <X> RR <X> conviction <N>/5
   Evidence: <one-line summary>

🔄 Conviction updates (pending your confirmation):
⬇️ <TICKER> conviction 4→3: <one-line reason>

⚠️ Conflicts detected:
🚨 <TICKER>: existing LONG, new evidence suggests SHORT — awaiting direction from you

🚫 Blocked:
- <TICKER>: plan cap at 10 — no new plans until an existing one closes
- <TICKER>: RR 1.4:1 below minimum 2:1 — rejected

✔️ Conviction holds:
- <TICKER>: thesis unchanged, conviction 4/5
```

Steve replies with "confirm <TICKER>" to activate a pending plan, or "skip <TICKER>" to discard it.

---

## Policy reference

| Rule | Value |
|---|---|
| Conviction scale | 1–5 |
| Minimum reward:risk | 2:1 |
| Max active plans | 10 |
| Intraday drop trigger | >5% from session open |
| Risk sizing (regular) | HK$500 per trade |
| Risk sizing (meme) | HK$5,000 fixed |
| Caution/Risk Off overlay | conviction −1 (min 1) |

Never auto-apply any change. All proposals require Steve's explicit confirmation.
