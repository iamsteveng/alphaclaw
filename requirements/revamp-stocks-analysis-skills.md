# Revamp Stocks Analysis Related Skills — Requirements

_Issue: [#25 — Revamp stocks analysis related skills](https://github.com/iamsteveng/alphaclaw/issues/25)_

---

## Goals

Observable end-state from Steve's perspective, no implementation decisions:

1. **Autonomous plan lifecycle** — Trading plans are created, updated, and labelled by the agent without Steve confirming each one. Steve opens GBrain and sees current plans already classified.

2. **Single decision-mode vocabulary** — Every trading skill uses the same four labels when classifying a plan:
   - `usable-now` — Price is still near the planned entry and setup is intact. The plan says: size normally, place the stop immediately, use the exact plan rather than improvising.
   - `accumulate` — Build in partial size over time. Add only on orderly pullbacks, support holds, or confirmation days. Keep dry powder for better entries.
   - `extended-wait` — Do not chase. Wait for a reset, tight consolidation, or pullback into a new lower-risk entry. If the entry never comes, leave it alone.
   - `broken-action-required` — Original plan is invalid until rebuilt. If in the position: agent writes a specific exit/trim recommendation to the plan page and notifies via Telegram. If not in: agent marks plan closed and removes it from the active watchlist. Re-entry only after a fresh thesis and new levels are defined.

3. **Shared research framework** — The research methodology and decision-mode definitions live in one skill file. Watchlist builder, EOD loop, and trading plan builder all reference it. Updating that one file changes the behaviour of all three.

4. **GBrain as the single plan store** — All plan reads and writes go through the `gbrain` CLI. No skill hard-codes plan data in memory or writes it any other way. The `label` field is always one of the four values above.

5. **Price report unchanged** — The 15-minute watchlist price report continues to work as-is. It reads plans from GBrain via `gbrain list --filter type=trading-plan` and reports `status: active` and `status: pending-confirmation` plans.

6. **EOD learning loop is fully autonomous** — At 16:10 ET Monday–Friday the agent audits all active plans, updates labels and levels as needed, writes the analysis to `learning/YYYY-MM-DD` in GBrain, and sends a Telegram summary. No confirmation step.

7. **X post → trading plan pathway** — When a tweet or article is ingested into GBrain (`type: tweet` or `type: article`) containing a ticker, the watchlist builder can use the conviction expressed in that content as an input when creating or auditing a plan for that ticker.

---

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

### GBrain plan schema

- [ ] After any watchlist builder or plan-creation run, all `type: trading-plan` pages include a `label` field:
  ```bash
  gbrain list --filter type=trading-plan | grep "label:" | grep -vE "usable-now|accumulate|extended-wait|broken-action-required" | wc -l
  # must output 0
  ```

- [ ] No `type: trading-plan` page has `status: pending-confirmation` left by an autonomous run (only manual/legacy plans may have this status):
  ```bash
  # After a fresh watchlist-builder cron run (not a manual override):
  gbrain list --filter type=trading-plan | grep "status: pending-confirmation"
  # must output nothing for plans created on the current date
  ```

### Shared framework is the single source of truth

- [ ] A skill file exists at `lib/setup/skills/trading-framework/SKILL.md` containing the four label definitions.
- [ ] Watchlist builder, EOD loop, and trading plan builder each contain exactly one reference to the shared framework (grep for the skill name, not a copy of the label text):
  ```bash
  grep -l "trading-framework" lib/setup/skills/watchlist-builder/SKILL.md \
    lib/setup/skills/trading-price-report/SKILL.md
  # must list both files
  ```
  _(trading-price-report does not use decision modes; this check confirms it is NOT copied there.)_

### stocks-signals is the single data source

- [ ] Every skill that reads price or technical data calls `finnhub_signals.py` — no direct Finnhub HTTP calls in skill SKILL.md files:
  ```bash
  grep -rE "finnhub\.io/api" lib/setup/skills/watchlist-builder/ lib/setup/skills/trading-price-report/
  # must output nothing (all calls go through the script, not raw curl)
  ```

### Watchlist builder — autonomous activation

- [ ] Trigger the watchlist builder via the cron message and verify the newest plan written to GBrain has `status: active` (not `pending-confirmation`):
  ```bash
  # Run a single watchlist builder cycle:
  docker exec <container> bash -c "HOME=/data openclaw agent --agent main \
    --message 'build watchlist — execute now, no confirmation needed.' 2>/dev/null"
  
  # Check newest plan status:
  docker exec <container> bash -c \
    "HOME=/data gbrain list --filter type=trading-plan --sort updated_at:desc --limit 1" \
    | grep "status:"
  # must output: status: active
  ```

### EOD learning loop — autonomous GBrain write

- [ ] After triggering the EOD loop message, `learning/YYYY-MM-DD` (today's date) exists in GBrain with non-empty content:
  ```bash
  TODAY=$(date +%Y-%m-%d)
  docker exec <container> bash -c "HOME=/data gbrain get learning/$TODAY" | wc -c
  # must be > 100 (non-trivial content written)
  ```

- [ ] The EOD loop writes `type: eod-analysis` frontmatter:
  ```bash
  TODAY=$(date +%Y-%m-%d)
  docker exec <container> bash -c "HOME=/data gbrain get learning/$TODAY" | grep "type: eod-analysis"
  # must match
  ```

### Broken plan pathway

- [ ] When the agent labels a plan `broken-action-required` for a ticker and the plan had `status: active`, the plan body contains a specific exit or trim recommendation (not just a label change):
  ```bash
  # For a known broken plan (e.g. plans/aapl after forcing broken state):
  docker exec <container> bash -c "HOME=/data gbrain get plans/aapl" | grep -iE "exit|trim|close"
  # must match at least one line
  ```

### stocks-signals API key presence

- [ ] `FINNHUB_API_KEY` is set in the running container before any signal fetch — a missing key must cause the skill to fail with a non-zero exit, not silently return empty data:
  ```bash
  docker exec <container> bash -c "FINNHUB_API_KEY='' python3 /data/.openclaw/workspace/skills/stocks-signals/finnhub_signals.py AAPL --json; echo exit=$?"
  # must output: exit=1 (or any non-zero value)
  ```

---

## Constraints

The following must not change as a result of this work:

- `lib/server/routes/trading-crons.js` cron schedule expressions and timeout values — only the message payloads may change.
- `trading-price-report` output format (header, APPROACHING ENTRY block, Full Watchlist code block) — Steve's Telegram client displays the existing format.
- `stocks-signals/finnhub_signals.py` JSON field names — downstream skills depend on `price.current`, `technicals.rsi14`, `analyst.consensus`, `earnings_days_away`, `fundamentals.pe`.
- `market-risk-score` skill — no changes; the watchlist builder continues to read it as-is.
- `variant-perception` skill — out of scope.
- `pentimento` skill — out of scope.
- GBrain `plans/<TICKER>` slug convention — existing plans must remain readable after the revamp.
- The `gbrain restore plans/<ticker> 2>/dev/null` call before any `gbrain put plans/<ticker>` — this is required to handle soft-deleted pages and must be preserved in all plan-write steps.

---

## When You Need Human Feedback

_(none — all open questions resolved via PR comment 2026-07-02)_

### Resolved decisions

**1. `broken-action-required` — auto-label only (option b)**
Agent sets `label: broken-action-required` and writes a specific exit/trim recommendation into the plan body, then sends a Telegram notification. `status` stays `active` until Steve manually closes it. The agent never auto-sets `status: closed`.

**2. X post conviction pathway — existing chain is sufficient**
The existing `type: tweet` / `type: article` → GBrain ingestion → watchlist-builder cron chain covers the X post use case. No new direct-message skill trigger is needed.

**3. EOD loop scope — label updates only**
The EOD loop updates `label` only. It does not modify `entry`, `target`, or `invalidation` levels. Full plan rebuilds (level changes) remain the exclusive responsibility of the watchlist builder.
