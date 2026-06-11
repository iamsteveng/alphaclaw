# Trading Plan Requirements

## 1. Plan Structure

Every trading plan must include:

```yaml
entry: <price>        # Entry price based on analysis, not just live/closing price
target: <price>       # Realistic upside target
invalidation: <price> # Stop loss — where the thesis breaks
direction: LONG|SHORT
ticker: <SYMBOL>
rr_ratio: <number>    # (target - entry) / (entry - invalidation)
setup_rating: 1-5     # Entry quality at current price
status: active|pending-confirmation|closed
type: trading-plan
```

## 2. Data Sources (Free Tier Only)

### Stocks signals
- Use stocks signals skill

### Tertiary: GBrain
- X posts content
- Historical trading plans
- Previous conviction points
- Closed plan outcomes
- `people/` pages for analyst profiles

## 3. Entry Determination

### Rules
1. Entry is NOT the closing price. Entry is the price where you'd place a limit order with conviction.
2. Do NOT lower the entry just because the stock closed below it — that's anchoring, not analysis.
3. Use `/stock/candle` data + `/scan/support-resistance` to find structural entry zones.
4. Entry must be above the invalidation by at least 2x the risk-free rate opportunity cost.
5. If you don't know where to enter, say so. Don't guess.

### Preferred Entry Types (ranked)
1. **Pullback to support** — Stock at 50-day EMA or S2 pivot in an uptrend
2. **Post-catalyst consolidation** — S&P inclusion, MSCI inclusion, analyst upgrade
3. **Capitulation wick** — Big red candle on no company-specific news, thesis intact
4. **Breakout retest** — Stock breaks out, pulls back to test the breakout level
5. **Chasing** — Stock already ran, entering because "it might keep going" — AVOID

## 4. Invalidation (Stop) Placement

### Rules
1. Sources: stocks signals, X posts content in GBrain
2. Stop must be at a structural level, not an arbitrary percentage.
3. Stop must be BELOW the level — not AT it. If support is $50, stop is $49.50.
4. For beta > 3: widen stop to account for gap risk.
5. If stop placement makes R/R < 1.5, the setup is not viable.

## 5. Target Determination

### Rules
1. Target must be at a realistic resistance level, not a round number.
2. Sources: stocks signals, X posts content in GBrain
3. R/R must be ≥ 2.0 for LONG, ≥ 1.5 for SHORT.
4. If target requires "everything to go right," lower it.
5. Multi-target plans are acceptable: T1 at analyst consensus, T2 at 52-week high.

## 6. Conviction Points (3-4 required)

### Requirements
1. Each conviction point must cite a specific source (analyst name, financial metric, news event).
2. At least one point must reference FinX analyst consensus or a specific analyst post.
3. At least one point must reference financial/technical data (not just narrative).
4. Conviction points must be falsifiable — you should know when one has broken.
5. Rating: 1 = speculative, 2-3 = thesis-backed, 4-5 = multi-catalyst with institutional validation.

## 7. Setup Rating Framework (1-5)

| Rating | Criteria |
|--------|----------|
| 5 | Multi-catalyst, analyst confirmation, at/above entry with strong R/R, no earnings risk within 2 weeks |
| 4 | Strong thesis, good R/R, one clear catalyst, technical setup valid |
| 3 | Decent thesis, acceptable R/R, some concerns (valuation, binary catalyst, entry timing) |
| 2 | Thesis intact but entry is expensive/extended, R/R compressed, or setup deteriorating |
| 1 | Speculative, chasing, or thesis weakening — should probably not exist |

## 8. Risk Section

Every plan must include risks covering:
- Company-specific (earnings, debt, customer concentration, competitive threat)
- Valuation (P/E, P/S vs peers, "priced for perfection" risk)
- Technical (beta, gap risk, "easy money already made" if extended)
- Catalyst-specific (binary event risk, timing uncertainty)
- Analyst rotation risk (if thesis leans on X analyst who could change their mind)

## 9. Plan File Format

### GBrain storage
- Slug: `plans/<ticker>`
- Type: `trading-plan`
- Content: Markdown with YAML frontmatter containing all plan fields
- Tags: none (use frontmatter for search)

### Frontmatter schema
```
entry, target, invalidation, ticker, rr_ratio, direction, status, type, setup_rating, closed_date?, closed_reason?
```

## 10. What NOT to Do

- Don't set entry to the current price just because you don't know where else to put it
- Don't rate every plan 3/5 because it's the default
- Don't chase entry down when the stock drops — either the thesis holds or it doesn't
- Don't cite an analyst you haven't actually checked today
- Don't keep a plan alive after the thesis is broken
- Don't build a plan for a stock you can't get price data for
- Don't use conviction = 3 as a default — differentiate
