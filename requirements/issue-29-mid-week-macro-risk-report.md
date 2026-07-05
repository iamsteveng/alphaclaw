# PRD: Main Agent Skill for Mid-Week Macro + Risk Confirmation Report — Requirements

_Issue: [#29 — PRD: Main Agent Skill for Mid-Week Macro + Risk Confirmation Report](https://github.com/iamsteveng/alphaclaw/issues/29)_

---

## Goals

Observable end-state from Steve's perspective, no implementation details:

1. **On-demand, chat-triggered report.** Steve can message the main OpenClaw agent with a natural trigger phrase (e.g. "mid-week macro report") at any time and receive back a **Mid-Week Macro + Risk Confirmation Report**, without a custom one-off workflow being built each time.

2. **Installed as a skill.** The report generator is a discoverable, reusable skill on the main agent (`lib/setup/skills/<name>/SKILL.md`), not an ad hoc prompt or one-time script. It shows up in `HOME=/data openclaw skills list` and is invocable by trigger phrase.

3. **Four-part report, one deliverable.** Every report contains, in order:
   - **Macro regime read** — the current U.S. Treasury yield curve shape compared against its own shape 4, 8, and 12 weeks ago, with a plain-language regime call (e.g. bear flattening, bull steepening).
   - **Cross-asset risk-on/risk-off read** — a ranked comparison of return and volume behavior (4-week vs 1-week window) across the fixed-income, equity, dollar, and gold universe, with a plain-language verdict on whether the market is rotating risk-on or risk-off.
   - **Credit vs equity risk confirmation** — a side-by-side table of return, volume, and volatility statistics (4-week vs 1-week) for high grade bonds, high yield bonds, and the three major equity indices, each carrying a signal label (e.g. defensive accumulation, distribution) plus a one-line key takeaway.
   - **Per-index technical setup** — for Russell 2000, S&P 500, and Nasdaq 100: current structural bias (bullish/bearish/transitioning), and explicit validation and invalidation price levels that would confirm or reject the prevailing thesis.

4. **Consistent, decision-useful format week over week.** The section order, table columns, and terminology are the same every time the skill runs, so two reports from different weeks are directly comparable at a glance.

5. **Data reflects real market conditions at request time**, not placeholder or stale cached values — every figure in the report (yields, returns, volume, volatility, price levels) is computed from a live data fetch performed during that run.

---

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

### Skill exists and is discoverable

- [ ] A skill directory exists with a `SKILL.md` containing `name`, `description`, and `triggers` frontmatter matching the report's invocation phrase:
  ```bash
  grep -l "^name:" lib/setup/skills/*/SKILL.md | xargs grep -l "mid-week" -i
  # must return exactly one file
  ```
- [ ] The skill is visible to the gateway after a fresh container start:
  ```bash
  docker exec <container> bash -c "HOME=/data openclaw skills list" | grep -i "mid-week"
  # must match
  ```

### Report generation — end to end

- [ ] Triggering the skill via a fresh agent session produces a single report containing all four required section headers (exact wording TBD in skill authoring, but each must be unambiguously present):
  ```bash
  OUT=$(docker exec <container> bash -c "HOME=/data openclaw agent --agent main \
    --message 'mid-week macro report — execute now, no confirmation needed.' 2>/dev/null")
  echo "$OUT" | grep -iE "yield curve"
  echo "$OUT" | grep -iE "return.*z-score|z-score.*return"
  echo "$OUT" | grep -iE "credit vs equity|risk confirmation"
  echo "$OUT" | grep -iE "validation|invalidation"
  # each grep must match at least one line
  ```
- [ ] The report header includes the current date (not a hardcoded or stale date):
  ```bash
  TODAY=$(date +%Y-%m-%d)
  echo "$OUT" | grep -F "$TODAY"
  # must match
  ```

### Yield curve data — FRED, all six tenors present and live

- [ ] The report cites a distinct yield value for each of the six tenors shown in the reference (3M, 2Y, 5Y, 10Y, 20Y, 30Y), sourced from FRED series `DGS3MO`, `DGS2`, `DGS5`, `DGS10`, `DGS20`, `DGS30`:
  ```bash
  for series in DGS3MO DGS2 DGS5 DGS10 DGS20 DGS30; do
    curl -sf "https://api.stlouisfed.org/fred/series/observations?series_id=$series&api_key=$FRED_API_KEY&file_type=json&sort_order=desc&limit=1" \
      | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['observations'][0]['value'] != '.'; print('$series', d['observations'][0]['value'])"
  done
  # each series must print a numeric value, not error or "."
  ```
- [ ] If `FRED_API_KEY` is unset or invalid, the skill fails loudly (non-zero exit / explicit error surfaced in the report), not a silent fallback to placeholder numbers:
  ```bash
  docker exec <container> bash -c "FRED_API_KEY='' python3 <path-to-yield-curve-script>.py --json; echo exit=$?"
  # must output: exit=<non-zero>
  ```

### Cross-asset Z-score table — all required assets present

- [ ] The Credit vs Equity dashboard includes a row for each of: High Grade Bonds, High Yield Bonds, S&P 500, Russell 2000, Nasdaq 100 — and each row has a non-empty Return Z-score, Volume Z-score, Volatility Z-score, and Signal Label for both the 4W and 1W windows:
  ```bash
  for asset in "High Grade" "High Yield" "S&P 500\|SPY" "Russell 2000\|IWM" "Nasdaq 100\|QQQ"; do
    echo "$OUT" | grep -iE "$asset"
  done
  # each must match
  ```

### Technical levels — explicit numeric validation/invalidation per index

- [ ] For each of Russell 2000, S&P 500, Nasdaq 100, the report states a numeric validation level and a numeric invalidation level (not a vague description):
  ```bash
  echo "$OUT" | grep -iE "(russell 2000|iwm)[^\\n]*(validation|invalidation)[^\\n]*[0-9]"
  echo "$OUT" | grep -iE "(s&p ?500|spy)[^\\n]*(validation|invalidation|lower high|lower low)[^\\n]*[0-9]"
  echo "$OUT" | grep -iE "(nasdaq|qqq)[^\\n]*(validation|invalidation)[^\\n]*[0-9]"
  # each must match at least one line with an adjacent numeric price
  ```

### Delivery

- [ ] The report is deliverable through the same channel path as existing trading skills (Telegram, per `delivery.mode: "announce"` convention) — verify a test invocation reaches the configured channel rather than only stdout:
  ```bash
  # Manual: trigger via the same cron/message path used by watchlist-builder and inspect
  # the configured Telegram channel for the report within the run window.
  ```

---

## Constraints

What must NOT change as a result of this work:

- `lib/server/routes/trading-crons.js` — existing job schedules, timeouts, and payloads for `trading-watchlist-builder`, `trading-price-report`, `trading-eod-loop` are untouched.
- `lib/server/routes/market-risk-score.js` and the `market-risk-score` skill — no changes. The new skill may reuse its z-score computation pattern (`market_risk_score.py`'s `zscore_n()`) as a reference implementation, but must not modify that file.
- `trading-framework`, `watchlist-builder`, `trading-price-report`, `eod-loop` skills — out of scope; this report does not read or write `type: trading-plan` GBrain pages.
- `stocks-signals/finnhub_signals.py` — no changes; this report does not depend on Finnhub (yield curve and cross-asset data come from FRED and Yahoo Finance per existing `market-risk-score` precedent).
- `variant-perception` and `pentimento` skills — out of scope.
- `lib/server/constants.js` — adding a new `FRED_API_KEY` entry to `kKnownVars` (mirroring how other provider keys are registered) is in scope; renaming or restructuring existing entries is not.
- No new server-side chart-image rendering pipeline (canvas/puppeteer/playwright/sharp) is introduced unless the Human Feedback item below resolves in favor of one — this is a deliberate scope boundary, not an oversight.

---

## When You Need Human Feedback

**1. Text/table report vs. pixel-accurate chart images.**
The reference image is a fully designed web page with rendered line charts, a colored ranked-waterfall bar chart, and a heat-mapped dashboard table. This repo has no server-side chart/image-rendering capability today — every existing trading skill (`watchlist-builder`, `trading-price-report`, `eod-loop`, `market-risk-score`) delivers plain-text/Markdown-table output to Telegram, and the only charting library present (`chart.js`) is client-side-only for the admin dashboard UI. Building true chart-image generation (e.g. a headless-render pipeline) is a materially larger effort than a text/table report carrying the same data.
_Suggested resolution:_ ship v1 as a well-formatted text/Markdown report (tables + bullet narrative) carrying all the same data points and verdicts as the reference, and treat actual chart-image rendering as a follow-up if the text version isn't "decision-useful" enough in practice.
Tag @iamsteveng in the PR comment to confirm.

**2. Exact instrument mapping for each asset category.**
The reference image labels assets generically (e.g. "U.S. 1-3Y", "High Grade Bonds", "Nasdaq 100") without stating the underlying tickers. Proposed default mapping (Yahoo Finance, no-auth, consistent with the `market-risk-score` precedent):

| Reference label | Proposed ticker |
|---|---|
| U.S. 0-3M | `BIL` |
| U.S. 1-3Y | `SHY` |
| U.S. 7-10Y | `IEF` |
| U.S. 20Y+ | `TLT` |
| High Grade Bonds | `LQD` |
| High Yield Bonds | `HYG` |
| Russell 2000 | `IWM` |
| S&P 500 | `SPY` |
| Nasdaq 100 | `QQQ` |
| U.S. Dollar | `UUP` (or `DX-Y.NYB`) |
| Gold | `GLD` |

Tag @iamsteveng in the PR comment to confirm or override before implementation.

**3. Z-score and volatility methodology.**
The reference report's exact z-score baseline window and volatility definition are proprietary to its source ("Intermarket Flow") and not derivable from the image alone. Proposed default: reuse the existing codebase convention from `market_risk_score.py` / `DXY_equity_risk_monitor_requirement.md` — 60-day rolling mean/std for return and volume z-scores, ATR14-based realized volatility for the volatility z-score. This is a reasonable default but not verified to match the reference's actual methodology.
Tag @iamsteveng in the PR comment to confirm.

**4. Validation/invalidation level calculation.**
In the reference, per-index validation/invalidation levels (e.g. Russell 2000's "305 invalidation" / "287.2 validation", the SPY lower-high/lower-low annotations, Nasdaq's 712/750 levels) read as a human analyst's manually drawn trendlines and point-of-control levels — there is no existing algorithmic definition for this in the codebase (the `stocks-signals` skill explicitly notes support/resistance detection is Finnhub-premium-only and not implemented). Proposed default: derive validation/invalidation as prior-N-day swing high/low ± an ATR-based buffer (same pattern as the ATR-adjusted breakout signal already defined in `DXY_equity_risk_monitor_requirement.md`), rather than attempting to replicate hand-drawn trendline analysis.
Tag @iamsteveng in the PR comment to confirm this approximation is acceptable, or to supply the exact rule.

**5. Recurring cron vs. purely on-demand.**
Issue #29 only requires the report to be triggerable by chat message; it does not request an automatic recurring cron (unlike `market-risk-score`'s standalone 9 PM HKT job). Should this skill also get an optional scheduled cron (e.g. mid-week, matching the "Mid-Week" framing), or is on-demand-only sufficient for v1?
Tag @iamsteveng in the PR comment to confirm.

---

## Open Questions Template

- External API shape: FRED official REST API confirmed (`https://api.stlouisfed.org/fred/series/observations?series_id=<ID>&api_key=<KEY>&file_type=json`), requires a free `FRED_API_KEY` — not yet provisioned anywhere in this repo. Series IDs for all six tenors verified live via `fredgraph.csv` during research (`DGS3MO`, `DGS2`, `DGS5`, `DGS10`, `DGS20`, `DGS30` all return data).
- Ambiguous scope: see Human Feedback items 1–5 above — asset mapping, z-score methodology, technical level calculation, chart-vs-text delivery, and cron cadence are all open.
- Test correctness uncertain: the "polished / visually aligned with reference" success criteria in the issue are inherently subjective; the Verifications section above is scoped to what's scriptable (structure, data presence, live-data freshness) — visual/tone quality will need a human review pass after v1 ships, not an automated check.
