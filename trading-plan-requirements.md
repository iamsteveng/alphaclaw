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
conviction: 1-5       # Thesis strength
setup_rating: 1-5     # Entry quality at current price
status: active|pending-confirmation|closed
type: trading-plan
```

## 2. Data Sources (Free Tier Only)

### Primary: Finnhub API
- `/quote` — Live price for entry determination
- `/stock/candle` — OHLCV bars for support/resistance levels
- `/indicator` — RSI, MACD, BB, SMA/EMA for technical context
- `/scan/support-resistance` — Automated SR levels for stop placement
- `/stock/metric` — 52w range, beta, P/E, P/B, P/S, margins
- `/stock/profile2` — Company name, industry, market cap
- `/company-news` — 7-day news: earnings, partnerships, upgrades, catalysts
- `/news-sentiment` — Sentiment scoring for sentiment-driven trades
- `/calendar/earnings` — Flag plans with near-term earnings risk
- `/stock/price-target` — Analyst consensus: high, low, mean
- `/stock/recommendation` — Buy/hold/sell trend

Rate limit: 60 calls/min. Full 13-ticker refresh ≈ 40-50 calls.

### Secondary: X List (steve-x-reader)
- List ID: `2055114771159261361`
- Auth: OAuth1 via xurl CLI
- Key analysts: @aleabitoreddit, @asklivermore, @SRxTrades, @itschrisray, @Sandeman52, @dampedspring, @moninvestor, @investingluc, @BlackPantherCap, @CaesarCapitalz, @ValueInIdeas

### Tertiary: GBrain
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
1. Stop must be at a structural level, not an arbitrary percentage.
2. Sources: Finnhub SR pivot points, 8-week EMA, 50-day SMA, prior consolidation low.
3. Stop must be BELOW the level — not AT it. If support is $50, stop is $49.50.
4. Risk per share = entry - stop. Must be ≤ 15% of entry for non-speculative plan.
5. For beta > 3: widen stop to account for gap risk.
6. If stop placement makes R/R < 1.5, the setup is not viable.

## 5. Target Determination

### Rules
1. Target must be at a realistic resistance level, not a round number.
2. Sources: analyst PT high, 52-week high, next resistance from Finnhub SR.
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

## 9. X Intelligence Integration

### Requirements
1. Check X list for mentions of the ticker before building or updating any plan.
2. If @aleabitoreddit, @asklivermore, or @SRxTrades has posted about it, that goes in conviction.
3. Include post date, engagement metrics (❤️/🔁), and exact quote.
4. If an analyst who was bullish goes silent or turns cautious, flag it in risks.
5. X intelligence must be dated — a post from 3 weeks ago is not current conviction.

## 10. Plan Maintenance

### Daily Review (EOD)
1. Pull all active plans from GBrain
2. Fetch live quotes via Finnhub `/quote` for all tickers
3. Compare current price to entry: above/below, by how much
4. Check Finnhub `/company-news` for any new catalysts
5. Check X list for any ticker mentions
6. Update plan if: thesis changed, new catalyst appeared, price hit target or approached stop
7. Do NOT update entry just because price closed below it (see Rule 3.2)

### When to Close a Plan
- Target hit → mark `status: closed`, `closed_reason: target_hit`
- Stop hit → mark `status: closed`, `closed_reason: stopped_out`
- Thesis broken → mark `status: closed`, `closed_reason: thesis_broken`
- Earnings within 3 days and no clear catalyst edge → temporary close or flag

## 11. Plan File Format

### GBrain storage
- Slug: `plans/<ticker>`
- Type: `trading-plan`
- Content: Markdown with YAML frontmatter containing all plan fields
- Tags: none (use frontmatter for search)

### Frontmatter schema
```
entry, target, invalidation, ticker, rr_ratio, direction, conviction, status, type, setup_rating, closed_date?, closed_reason?
```

## 12. What NOT to Do

- Don't set entry to the current price just because you don't know where else to put it
- Don't rate every plan 3/5 because it's the default
- Don't chase entry down when the stock drops — either the thesis holds or it doesn't
- Don't cite an analyst you haven't actually checked today
- Don't keep a plan alive after the thesis is broken
- Don't build a plan for a stock you can't get price data for
- Don't use conviction = 3 as a default — differentiate
