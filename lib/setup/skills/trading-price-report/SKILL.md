---
name: trading-price-report
description: Generate a watchlist price report showing current prices vs entry targets for all active trading plans. Checks market status, computes signed distance from entry, highlights approaching-entry alerts (≤2%), and outputs a formatted Telegram report.
triggers:
  - "Get watchlist price report"
  - "watchlist price report"
  - "price report"
---

# Trading Price Report

Generates a formatted price report for all active/pending trading plans during US market hours.

**STRICT OUTPUT RULES:**
- Your entire response is ONLY the report below. Nothing else.
- NO markdown tables.
- NO market-risk commentary.
- NO "Full Price Feed" or similar sections.
- The only tickers that appear in your output are those with a GBrain trading-plan page. Prices fetched via the stocks-signals skill are for internal computation only — do NOT output data for any ticker not in Step 1.

---

## Step 0 — Check market status

```bash
curl -s "https://finnhub.io/api/v1/stock/market-status?exchange=US&token=$FINNHUB_API_KEY"
```

If `isOpen` is `false`, output `Market closed — skipping price report.` and stop.

---

## Step 1 — Load GBrain plans

```bash
gbrain list --filter type=trading-plan
```

For each page where `status` is `active` OR `pending-confirmation`, read the full page and extract: `ticker`, `direction` (LONG or SHORT), `entry` (number), `setup_rating`.

---

## Step 2 — Get current prices

For each ticker from Step 1, get stocks signals to fetch the current price:

> Get stocks signals for TICKER

Use the `price.current` field from the result. This is for internal price lookup only — do not reference or output any ticker not found in Step 1.

---

## Step 3 — Compute signed dist%

    LONG:  dist% = (current_price - entry) / entry * 100
    SHORT: dist% = (entry - current_price) / entry * 100

- Positive = price moved in favorable direction
- Negative = price moved against entry
- Round to 1 decimal place. Use `n/a` if price missing.

---

## Step 4 — Build and output the report

### Header (lines 1–2)

    📊 Watchlist Price Report
    Fri Jun 12 · 14:30 UTC · 🇺🇸 Market Open

### APPROACHING ENTRY section

Only include if any plan has abs(dist%) ≤ 2% (skip n/a). Omit this entire block otherwise.

    ⚠️ APPROACHING ENTRY (≤2%)
    
    • NVDA LONG — Entry $205 · Now $208.64 · 1.8% above

Label rules:
- dist% == 0 → `AT entry`
- dist% > 0 → `<dist%>% above`
- dist% < 0 → `<abs(dist%)>% below`

### Full Watchlist section

Output this header line:

    📋 Full Watchlist (dist% · entry → now)

Then output a fenced code block with one row per plan, sorted by dist% ascending (most negative first, n/a last). Each row uses space-padded columns:

- Col 1: ticker, left-aligned, 6 chars
- Col 2: direction, left-aligned, 6 chars  
- Col 3: `$<entry> → $<current>` (no trailing zeros past 2dp, e.g. `$920`, `$9.50`, `$208.64`)
- Col 4: dist% right-aligned in 7 chars — prefix `+` if positive, `-` if negative, no prefix for `0.0%`, `n/a` if missing
- Col 5: `★<setup_rating>`

Example of a correctly-formatted single-plan output:

    📊 Watchlist Price Report
    Fri Jun 12 · 14:11 UTC · 🇺🇸 Market Open
    
    ⚠️ APPROACHING ENTRY (≤2%)
    
    • NVDA LONG — Entry $205 · Now $208.64 · 1.8% above
    
    📋 Full Watchlist (dist% · entry → now)
    ```
    NVDA   LONG   $205 → $208.64    +1.8%  ★2
    ```

That is the complete response. No extra text before or after.
