---
name: basing-watch
description: Track downtrending tickers waiting for a base to form. Computes a mechanical sideways streak (no ≥3% down day, closes inside a ±5% band) per ticker, sends a daily EOD Telegram digest, and on base-confirmed (10 qualifying days) auto-graduates the ticker to watchlist-builder for a real trading plan. Also handles adding/removing tickers from the watch via chat.
triggers:
  - "basing watch digest"
  - "basing watch"
  - "basing-watch"
  - "add to basing watch"
---

# Basing Watch

Watches tickers that are in a downtrend and **not yet buyable** — no entry/target/invalidation exists. Its only job is to detect when the downtrend has stopped, then hand the ticker to `watchlist-builder`. Vocabulary (Big Down Day, Band, Streak, Stabilizing, Base-Confirmed, Graduation) is defined in `CONTEXT.md` at the alpha-claw repo root; the mechanical rules live in `basing_watch.py` — never recompute streaks by hand.

States: `downtrending` → `stabilizing` (streak ≥ 5) → `base-confirmed` (streak ≥ 10, graduates). Any ≥3% down day or close outside the ±5% band resets the streak and re-anchors the band.

This skill never assigns decision-mode labels — that happens downstream in `watchlist-builder` / `trading-framework` after graduation.

---

## Watch pages

One GBrain page per watched ticker, slug exactly `basing-watch/<ticker-lowercase>` (e.g. `basing-watch/mu`).

Frontmatter:

```yaml
type: basing-watch
ticker: MU
status: active        # active | graduated | removed
state: downtrending   # downtrending | stabilizing | base-confirmed
streak: 3
last_evaluated: 2026-07-17
added: 2026-07-17
```

Body: an append-only log, one line per state transition or reset, newest last (e.g. `2026-07-16 — reset (big-down-day, -4.1%), streak 6 → 0`).

The streak is always **recomputed from price history** by the script — page fields are for reporting and transition detection only, never inputs to the computation.

---

## Daily digest (cron: trading-basing-watch, 16:15 ET Mon–Fri)

**STRICT OUTPUT RULES:**
- Your entire response is ONLY the digest. No preamble, no questions, no follow-ups.
- NO markdown tables.
- Only tickers with an `active` basing-watch page appear in the output.

### Step 1 — Load the watch

```bash
gbrain list --filter type=basing-watch
```

Keep pages where `status: active`. If there are none, output `Basing watch is empty.` and stop.

### Step 2 — Compute streaks

```bash
python3 /data/.openclaw/workspace/skills/basing-watch/basing_watch.py TICKER1 TICKER2 ... --json
```

If the latest close date for every ticker is older than today (America/New_York), it was a market holiday: output `Market closed today — no basing digest.` and stop.

### Step 3 — Earnings context

For each ticker:

```bash
python3 /data/.openclaw/workspace/skills/stocks-signals/finnhub_signals.py TICKER --section earnings --json
```

Note `earnings_days_away` for the digest and the ⚠ warning below.

### Step 4 — Update pages and detect transitions

For each ticker, compare the script's `state`/`streak` to the page's stored values, then rewrite the page (always restore first — see CLAUDE.md soft-delete rule):

```bash
gbrain restore basing-watch/<ticker> 2>/dev/null || true
gbrain put basing-watch/<ticker>
```

Update `state`, `streak`, `last_evaluated`; append a log line if the state changed or a reset occurred today (script `last_reset.date` == today).

### Step 5 — Graduation (state == base-confirmed)

1. Set the page's `status: graduated` and append a log line.
2. Invoke the `watchlist-builder` skill with an explicit force-rebuild for the ticker (its Step 1e), so it autonomously creates a `type: trading-plan` page with entry/target/invalidation and a decision-mode label.
3. In the digest, mark the line `🎓 BASE CONFIRMED → trading plan created`. If `earnings_days_away` ≤ 7 (calendar days ≈ 5 trading days), append `⚠ earnings in Nd`.

Graduated pages leave the watch — they are not evaluated on later runs. Buying remains the user's decision; this skill only ever produces a plan.

### Step 6 — Digest format

```
📉 Basing Watch — Jul 17
MU: downtrending — day 1/10 · reset Jul 16 (big down day) · earnings 23d
MRVL: stabilizing — day 7/10 · band room -4.4% / +5.6% · earnings 40d
🎓 ARM: BASE CONFIRMED (day 10/10) → trading plan created ⚠ earnings in 3d
```

One line per ticker: state, `day N/10`, band room from the script's `distance` field, days to earnings. Resets that happened today are called out on the line. Send every trading day, even when nothing changed.

After the ticker lines you may add **one** final `Note:` line of commentary — a single sentence calling out anything a mechanical line can't (e.g. "Note: all three reset on the same CPI print — sector-wide, not idiosyncratic."). The streak math above is authoritative; the note never contradicts it. Omit the line when there is nothing worth saying.

---

## Chat operations

**Add** (“add NVDA to basing watch”): create/rewrite `basing-watch/nvda` (restore first) with `status: active`, `added: <today>`, then run the script for that ticker and report its backfilled state and streak — history is backfilled automatically, so the first report may already read `stabilizing, day 6`.

**Remove** (“drop ARM from the basing watch”): set `status: removed`, append a log line. Do not delete the page.

**Status** (“basing watch status”): run Steps 1–3 and output the digest format, without updating pages.
