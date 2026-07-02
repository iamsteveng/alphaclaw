---
name: watchlist-builder
description: Build and maintain a trading watchlist from GBrain content. Generates trading plans for new tickers, audits conviction on existing ones, enforces policy gates (max plans, conflict detection, RR ≥ 2:1, market risk overlay). All plans are written autonomously as status:active with a label. No confirmation step. Invoke when asked to build the watchlist, generate a trading plan, or audit existing plans. Also triggered by the trading-watchlist-builder cron at 08:00 ET.
triggers:
  - "build watchlist"
  - "audit watchlist"
---

# Watchlist Builder + Trading Plan Generator

Runs ~08:00 ET daily (before US market open). Reads GBrain for fresh content, processes each ticker, and writes plans autonomously. Decision-mode labels and the broken-plan procedure are defined in the `trading-framework` skill — do not copy them here.

---

## Step 1 — Fetch inputs

```
1a. Get pages with type=tweet or type=article posted within 24h from GBrain, limit 100.

1b. Extract ticker symbols from the pages fetched in 1a.
    A ticker is a 1–5 character uppercase symbol (e.g. AAPL, TSLA, NVDA).
    Include a ticker if it appears as: $TICKER, "TICKER stock", "TICKER shares", or standalone uppercase in a financial context.
    Exclude common non-ticker uppercase words: IPO, ETF, CEO, CFO, USD, HKD, NYSE, NASDAQ, AI, US, EU, UK, GDP, EPS, PE.
    Deduplicate. This is the working list for Step 2.

1c. Read the current watchlist:
    gbrain get watchlist/current
    Extract active tickers and their conviction levels.

1d. Get the current market risk score.
    Note the classification (Risk On / Neutral / Caution / Risk Off).

1e. Check if one or more tickers were explicitly requested for rebuild (e.g. "rebuild AAOI, RDDT, ONDS").
    If yes, mark those tickers as force-rebuild. They will skip Step 3 entirely and go straight to Steps 4b–4e,
    regardless of whether an active plan already exists or whether the entry zone is still valid.
    Add them to the working list if not already present.
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
3. **Price structure**: get stocks signals for TICKER to fetch the current price. Is price still in the valid zone (above invalidation for LONG, below for SHORT)?

Apply the "existing plan" label rules from the `trading-framework` skill to determine the new label.

**Write the updated label directly to GBrain** (no pending — changes take effect immediately):

```bash
gbrain restore plans/<lowercase-ticker> 2>/dev/null
# Then write frontmatter with updated label + unchanged body
```

If the new label is `broken-action-required`, follow the full broken-plan procedure from the `trading-framework` skill: append `### Broken-Plan Action` to the plan body with a specific exit/trim recommendation, send Telegram notification for that ticker immediately, and keep `status: active`.

If all three checks still support the stored conviction: note "conviction holds, label unchanged" in the Step 6 announcement.

### 3d — Entry reachability check (run after the three checks above)

Using the current price from the stocks signals result (fetched in the check above) and the plan's stored `entry` and `invalidation`:

```
stop_distance = abs(entry - invalidation)
price_drift   = abs(current_price - entry)
```

**Stale if:**
- LONG: `current_price > entry` AND `price_drift > stop_distance` (price ran more than one stop-distance above entry — structural zone missed)
- SHORT: `current_price < entry` AND `price_drift > stop_distance` (price dropped more than one stop-distance below entry — structural zone missed)

**If stale:** the entry zone is no longer valid. Skip the conviction result and trigger a full plan rebuild:
- Run Steps 4b → 4e for this ticker (fetch fresh signals, generate new plan, save autonomously as `status: active` with label assessed from current price)
- In the Step 6 announcement, flag it as a rebuild: `♻️ <TICKER>: entry zone stale (price drifted X% past entry) — new plan written`

**If entry is still reachable:** proceed normally with the conviction audit result.

---

## Step 4 — Plan generation (new ticker)

### 4a — Policy gate: conflict detection

Read `plans/<TICKER>` (any status). If a plan exists with `status: active` in the **opposite direction** to what the new evidence suggests:

> "You have an active [LONG/SHORT] on [TICKER] — new evidence suggests [SHORT/LONG]. Skipping — resolve the conflict manually first."

Do NOT generate the new plan. Note the conflict in the Step 6 announcement.

### 4b — Fetch signals (MANDATORY — run before any level determination)

Get stocks signals for the ticker. Use the output for: current price, RSI(14) and rsi_zone, SMA10/20/50/200 positions, analyst consensus (buy/hold/sell counts + consensus label), next earnings date (earnings_days_away), beta, recent news headlines, P/E, P/S. If signals are unavailable, skip this ticker (note as NO_SIGNALS_DATA). Do NOT proceed to Step 4c without fetching signals first.

### 4c — Generate the trading plan

**Entry** — Entry is NOT the current price or closing price. Identify a structural entry zone using signals data. Preferred types in order: (1) Pullback to support near SMA50 in an uptrend; (2) Post-catalyst consolidation after an upgrade or index inclusion; (3) Capitulation wick on no company-specific bad news; (4) Breakout retest. AVOID chasing. Do NOT lower entry because current price dropped — that is anchoring. If no structural entry zone exists, skip (NO_ENTRY_FOUND).

**Invalidation** — Stop must be at a structural level, not a percentage. For LONG: stop BELOW support (e.g. support $50 → stop $49.50). For SHORT: stop ABOVE resistance. If beta > 3, widen stop for gap risk. If R/R after stop placement < 1.5, skip (RR_BELOW_MINIMUM).

**Target** — Must be at a realistic resistance level, not a round number. Use SMA200, 52-week high/low, price structure. R/R minimum: 2.0 for LONG, 1.5 for SHORT. If achieving R/R requires everything to go right, lower the target.

**Conviction points (3–4 required):**
1. At least one must cite analyst consensus by count from signals (e.g. "Finnhub: 12 Buy, 3 Hold = Buy consensus")
2. At least one must cite a specific financial or technical data point from signals (RSI, SMA position, P/E, beta, specific news headline with date)
3. Every point must be falsifiable — state what would break it (e.g. "valid while above SMA50; breaks on weekly close below $X")
Do NOT write generic points like "strong momentum" or "positive sentiment."

**setup_rating (1–5) — do NOT default to 3:**
- 5 = multi-catalyst confirmed (analyst Buy/Strong Buy + specific news catalyst + technical entry alignment), R/R ≥ 3.0, earnings_days_away > 14
- 4 = strong thesis, one clear catalyst, R/R 2.5–3.0, analyst consensus at least Hold, valid technical setup
- 3 = decent thesis, R/R 2.0–2.5, some concerns (stretched valuation, binary catalyst, suboptimal timing)
- 2 = thesis intact but entry extended, R/R compressed near minimum, or setup deteriorating
- 1 = speculative, chasing, or thesis weakening — do NOT create, record as SETUP_TOO_WEAK

### 4d — Policy gate: reward:risk check

```
RR = abs(target - entry) / abs(entry - invalidation)
```

- If RR < 2.0 (LONG) or < 1.5 (SHORT): reject. Note the rejection reason.
- If RR ≥ minimum: proceed.

### 4e — Assign initial label and save to GBrain

**Assign initial label** using current price vs entry/invalidation (see "New plan" label rules in the `trading-framework` skill).

First run `gbrain restore plans/<lowercase-ticker> 2>/dev/null` to restore any soft-deleted version. Then write to `plans/<TICKER>`:

```yaml
---
type: trading-plan
ticker: <TICKER>
direction: LONG | SHORT
entry: <price>
target: <price>
invalidation: <price>
rr_ratio: <float, 2 decimal places>
setup_rating: <1-5>
status: active
label: <usable-now | accumulate | extended-wait>
---

## Trading Plan — TICKER DIRECTION

**Entry:** $ENTRY | **Target:** $TARGET | **Invalidation:** $INVALIDATION | **R/R:** RR_RATIO

### Conviction
1. [first conviction point — cite specific source]
2. [second conviction point — cite specific source]
3. [third conviction point — cite specific source]

### Risks
- **Company:** [earnings timing from signals, debt level, customer concentration, competitive threat]
- **Valuation:** [P/E or P/S from signals vs peers; priced for perfection?]
- **Technical:** [beta from signals, gap risk, easy money already made if extended?]
- **Catalyst:** [binary event risk or timing uncertainty]
- **Analyst:** [rotation risk if thesis depends on a specific analyst view]
```

---

## Step 5 — Update watchlist/current

`watchlist/current` is a **GBrain page**, not a flat file on disk. Always write it using `gbrain put`. Never use shell redirection (`>`) or any filesystem write to create or update this page.

**Self-correction:** If `watchlist/current` was accidentally created as a flat file (i.e., `gbrain get watchlist/current` fails or returns no content but a file exists on disk at a path like `watchlist/current`), you must fix it:
1. Delete the flat file: `rm -f <path-to-flat-file>`
2. Recreate it as a GBrain page using `gbrain put` (see below)

Write the summary using:

```bash
gbrain restore watchlist/current 2>/dev/null
gbrain put watchlist/current << 'EOF'
---
type: watchlist
updated_at: <ISO-8601>
---

## Active Tickers

- <TICKER> (label: <label>, direction: <LONG|SHORT>, conviction: <N>)
- ...
EOF
```

---

## Step 6 — Announce results

End your reply with a summary in this exact format (delivered via Telegram):

```
Watchlist Builder — <date> 08:00 ET
Market risk: <Risk On | Neutral | Caution | Risk Off>

✅ New plans written:
✅ <TICKER> [LONG/SHORT] entry <X> target <X> invalidation <X> RR <X> label <label>
   Evidence: <one-line summary>

🏷️ Conviction updates written:
⬇️ <TICKER> label usable-now→accumulate: <one-line reason>

⛔ Broken plans actioned:
⛔ <TICKER>: broken-action-required — <one-line reason> — exit recommendation written, Telegram sent

⚠️ Conflicts skipped:
🚨 <TICKER>: active LONG conflicts with new SHORT evidence — resolve manually

🚫 Blocked:
- <TICKER>: plan cap at 10 — no new plans until an existing one closes
- <TICKER>: RR 1.4:1 below minimum 2:1 — rejected

♻️ Rebuilt (entry zone stale):
✅ <TICKER> [LONG/SHORT] entry <X> target <X> invalidation <X> RR <X> label <label>
   Rebuilt because: price drifted X% past original entry

✔️ Conviction holds:
- <TICKER>: thesis unchanged, label usable-now
```

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

All plan writes are autonomous. Conflicts still require manual resolution.
