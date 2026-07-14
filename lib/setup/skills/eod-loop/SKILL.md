---
name: eod-loop
description: End-of-day learning loop. Audits all active trading plans, updates label only (never entry/target/invalidation), writes analysis to GBrain as learning/YYYY-MM-DD, and sends a Telegram summary. Runs autonomously at 16:10 ET Monday–Friday. No confirmation step.
triggers:
  - "EOD learning loop"
  - "end of day loop"
  - "eod loop"
---

# EOD Learning Loop

Runs at 16:10 ET Monday–Friday after US market close. Fully autonomous — no confirmation step. Updates **label only** on each active plan. Full plan rebuilds (level changes) are the exclusive responsibility of the `watchlist-builder` skill.

Decision-mode labels and the broken-plan procedure are defined in the `trading-framework` skill.

---

## Step 1 — Load active plans

```bash
gbrain list --filter type=trading-plan
```

Collect all pages where `status: active`. Extract: `ticker`, `direction`, `entry`, `target`, `invalidation`, `label`, `setup_rating`.

If there are no active plans, write a minimal learning entry (see Step 4) noting zero plans reviewed, then send a brief Telegram message and stop.

---

## Step 2 — Audit each plan

For each active plan, run the three conviction checks defined in the `trading-framework` skill:

**2a — Get signals**

```bash
python3 /data/.openclaw/workspace/skills/stocks-signals/finnhub_signals.py TICKER --json
```

Use the output for: `price.current`, `technicals.rsi14`, `technicals.rsi_zone`, SMA positions, `analyst.consensus`, `earnings_days_away`.

**2b — Three conviction checks**

1. **GBrain content**: any `type: tweet` or `type: article` posted in the last 24h mentioning this ticker — does it support or contradict the stored thesis?
2. **Market risk score**: run `market-risk-score` skill. Has classification shifted since the plan was written?
3. **Price structure**: is the current price still on the correct side of the `invalidation` level?

**2c — Assign new label**

Apply the "existing plan" label rules from the `trading-framework` skill:

| Condition | New label |
|---|---|
| All three checks pass AND entry still reachable | `usable-now` |
| One check weakened but thesis intact AND entry reachable | `accumulate` |
| Entry zone missed (price ran) but thesis still supportable | `extended-wait` |
| Invalidation breached OR two or more checks failed | `broken-action-required` |

**2d — Write label update to GBrain**

Only update the `label` field in the plan frontmatter. Do NOT modify `entry`, `target`, `invalidation`, `setup_rating`, or any other field.

```bash
gbrain restore plans/<lowercase-ticker> 2>/dev/null
# Then overwrite with updated frontmatter (label changed) + unchanged body
gbrain put plans/<lowercase-ticker> << 'EOF'
---
type: trading-plan
ticker: TICKER
direction: LONG | SHORT
entry: <unchanged>
target: <unchanged>
invalidation: <unchanged>
rr_ratio: <unchanged>
setup_rating: <unchanged>
status: active
label: <new-label>
---

<unchanged body>
EOF
```

If the new label is `broken-action-required`, follow the full broken-plan procedure from the `trading-framework` skill: append `### Broken-Plan Action` section with a specific exit/trim recommendation, and send a Telegram notification for that ticker immediately (do not wait for the Step 5 summary).

---

## Step 3 — Calibration observations

After auditing all plans, identify the top 2–3 calibration patterns across the portfolio:

- Plans where the label changed and why (e.g. "NVDA moved from usable-now → extended-wait: price ran 8% above entry in one session")
- Plans where the thesis held cleanly and what signal was most predictive
- Any systematic risk (e.g. "3 of 5 plans now extended-wait — market may be running ahead of entries")

---

## Step 4 — Write to GBrain

```bash
TODAY=$(date +%Y-%m-%d)
gbrain restore learning/$TODAY 2>/dev/null
gbrain put learning/$TODAY << 'EOF'
---
type: eod-analysis
date: YYYY-MM-DD
---

## EOD Analysis — YYYY-MM-DD

### Plans Reviewed

For each plan audited, one row:
- **TICKER** [LONG/SHORT] — label: old-label → new-label | price: $X (entry: $E, invalidation: $I) | reason: [one sentence]

### Calibration Observations

1. [First observation]
2. [Second observation]
3. [Third observation, if applicable]

### Broken Plans

List any plans marked broken-action-required today with the specific recommendation written.
If none: "None."
EOF
```

---

## Step 5 — Send full report to delivery channel

After writing the learning entry to GBrain (Step 4), send the **full report** to the delivery channel — the same content just written to `learning/YYYY-MM-DD`, not a condensed digest. Every plan reviewed gets a row, not just the ones that changed label.

Output this format — no questions, no follow-ups:

```
📊 EOD Loop — YYYY-MM-DD
Plans reviewed: N

### Plans Reviewed
TICKER [LONG/SHORT] — label: old → new | price: $X (entry: $E, invalidation: $I) | reason: [one sentence]
(one line per plan audited today — all N of them, unchanged plans included)

### Calibration Observations
1. [First observation]
2. [Second observation]
3. [Third observation, if applicable]

### Broken Plans
TICKER: broken-action-required — [reason] — action written to plans/ticker
(omit this section entirely if no plans are broken)

📝 Full analysis saved to learning/YYYY-MM-DD
```

**Message length:** if the assembled report would exceed roughly 1800 characters, split it into sequential messages labeled `(1/2)`, `(2/2)`, etc. and send them in order via the same delivery tool. Never truncate or drop plans/sections to fit — split instead.
