---
name: trading-framework
description: Shared research methodology and four decision-mode label definitions used by all trading skills. Reference this skill when labelling or auditing any trading-plan. Never copy the label text into another skill file.
triggers:
  - "trading framework"
  - "decision mode labels"
---

# Trading Framework — Shared Research Methodology

Single source of truth for trading plan classification. Every skill that creates, updates, or audits a `type: trading-plan` page in GBrain must apply these labels and methodology. Do not copy these definitions into another skill — reference this skill.

---

## Decision-Mode Labels

The `label` field on every `type: trading-plan` page must be exactly one of:

| Label | When to use | What the agent does |
|---|---|---|
| `usable-now` | Price is at or near the planned entry zone and setup is intact | Size normally, place stop immediately, follow the plan exactly |
| `accumulate` | Entry still reachable but conviction is building or price is slightly extended | Build partial size on orderly pullbacks, support holds, or confirmation days; keep dry powder |
| `extended-wait` | Price has run past the entry zone but thesis is intact | Do not chase; wait for a reset, tight consolidation, or pullback to a lower-risk entry |
| `broken-action-required` | Original plan is invalid (invalidation breached or thesis unsupportable) | See Broken-Plan Procedure below |

No other values are valid. Any plan without a `label` field or with an unlisted value is a schema error.

---

## Research Inputs (required order)

1. **Price and technicals** — `finnhub_signals.py` only (via the `stocks-signals` skill). No direct Finnhub HTTP calls.
2. **Analyst consensus** — `analyst` section of `finnhub_signals.py` output.
3. **Recent news** — `news` section of `finnhub_signals.py` output (last 7 days).
4. **Market risk overlay** — `market-risk-score` skill output (Risk On / Neutral / Caution / Risk Off).
5. **GBrain ingested content** — `type: tweet` and `type: article` pages posted within 24h.

---

## Label Assignment

### For a new plan

After fetching signals and establishing entry/invalidation, compare current price to the plan's structural zone:

```
stop_distance = abs(entry - invalidation)
price_drift   = abs(current_price - entry)
```

**LONG:**
| Condition | Label |
|---|---|
| current_price ≤ entry | `usable-now` |
| current_price > entry AND price_drift ≤ stop_distance / 2 | `accumulate` |
| current_price > entry AND stop_distance / 2 < price_drift ≤ stop_distance | `extended-wait` |
| current_price > entry AND price_drift > stop_distance | Entry zone already stale — reject with `NO_ENTRY_FOUND` instead of creating a plan |

For **SHORT**, reverse the comparison direction.

### For an existing plan (conviction audit or EOD)

| Condition | Label |
|---|---|
| All conviction checks pass AND entry still reachable | `usable-now` |
| One conviction check weakened but thesis intact AND entry reachable | `accumulate` |
| Entry zone missed (price ran) but thesis still supportable | `extended-wait` |
| Invalidation breached OR two or more conviction checks failed | `broken-action-required` |

---

## Broken-Plan Procedure

When a plan is labelled `broken-action-required`:

1. Update frontmatter: set `label: broken-action-required`. Do **NOT** change `status` — it stays `active` until Steve manually closes it.
2. Append a `### Broken-Plan Action` section to the plan body with a specific exit or trim recommendation. Example:
   ```
   ### Broken-Plan Action
   Exit remaining position at market open (or limit $X). Thesis invalidated by [specific reason].
   Do not re-enter until a fresh plan with new levels is created.
   ```
3. Send Telegram notification: `⛔ TICKER: broken-action-required — [one-line reason]. Check plans/ticker for action.`
4. Do not auto-close the plan or remove it from `watchlist/current` (a GBrain page — update via `gbrain put watchlist/current`, never a flat file).
