---
name: variant-perception
description: Run a deep variant perception analysis on any stock ticker — what Wall Street may be misunderstanding, ignoring, or underestimating. Based on @investingluc's high-value prompt structure.
metadata:
  openclaw:
    emoji: "🔬"
    triggers:
      - "variant perception"
      - "what is wall street missing"
      - "wall street missing"
      - "variant perception on"
      - "analyze ticker"
      - "deep dive ticker"
      - "consensus check"
      - "what is the market missing"
      - "contrarian analysis"
---

# Variant Perception Skill

## Overview

Run a structured variant perception analysis on any stock ticker. This skill uses a battle-tested prompt structure from @investingluc to surface what consensus may be wrong about — the bull case, bear case, hidden catalysts, and probability-weighted outcomes.

## Triggers

Any message requesting variant perception, contrarian analysis, or "what Wall Street is missing" on a ticker. Examples:
- "Variant perception on $PLTR"
- "What is Wall Street missing about NVDA?"
- "Deep dive AAPL — what's the market not seeing?"
- "Analyze CRWV variant perception"

## Workflow

### 1. Extract Ticker
Parse the user's message for a stock ticker. Accept formats: `$TICKER`, `TICKER`, or bare ticker.

### 2. Run Variant Perception Analysis
Use the following prompt structure against the active model, substituting the ticker:

```
You are a top-tier hedge fund analyst.

Analyze [TICKER].

Ignore consensus opinions and focus entirely on variant perception. Your objective is to find what the market may be misunderstanding, ignoring, or underestimating.

Provide:

1) Business Summary
- what does the company do?
- how does it make money?
- why does it matter?

> Bull Case
What could go right?
What are investors missing?
What hidden growth drivers exist?
What future catalysts could emerge?
What optionality is not reflected in the stock price?

> Bear Case
What could go wrong?
What risks are underappreciated?
What assumptions must be true for the thesis to fail?

> Variant Perception
What does Wall Street currently believe?
What alternative outcome could occur?
Why is consensus potentially wrong?

> Catalysts
Earnings
Product launches
Partnerships
Regulatory developments
Industry shifts
Capital allocation decisions

> Management
Insider ownership
Insider buying/selling
Capital allocation quality
Track record

> Competitive Position
Moat
Market share
Industry positioning
Competitive advantages

> Probability-Weighted Outcomes
Bear Case (% probability)
Base Case (% probability)
Bull Case (% probability)

If Wall Street is wrong and the bull case plays out, what would need to happen for this stock to double, triple, or become a long-term market leader?
```

### 3. Format Output

Present the analysis in clean sections. Use bold headers, bullet points for lists, and clear probability formatting. No markdown tables on messaging surfaces (Discord/WhatsApp/Telegram).

### 4. Ingest to GBrain

Save the full analysis as a brain page:
- **Slug:** `stocks/variant-perception-[TICKER]-[YYYY-MM-DD]`
- **Type:** analysis (or concept)
- **Tags:** `variant-perception`, `stocks`, ticker symbol
- **Timeline entry:** date + summary of key variant perception finding
- **Cross-link:** to the company page if it exists, and to any relevant concept pages

### 5. Surface the Key Insight

At the top of the response, highlight the single most important variant perception finding — the one insight that best captures what consensus is wrong about.

## Output Structure

```
🔬 Variant Perception: $TICKER — Company Name

💡 Key Insight: [One-sentence variant perception thesis]

## Business Summary
...

## Bull Case
...

## Bear Case
...

## Variant Perception
...

## Catalysts
...

## Management
...

## Competitive Position
...

## Probability-Weighted Outcomes
| Case | Probability | Scenario |
...

## Path to Multi-Bagger
What needs to happen for 2x, 3x, or market leader status.
```

## Quality Rules

- **Variant perception must be genuinely contrarian.** If consensus is "this is a great company," the variant perception should challenge WHY that might be wrong or WHAT the market is missing beyond the obvious.
- **Probabilities are estimates, not certainties.** State confidence clearly. A wide probability range is honest; false precision is not.
- **Separate thesis from price.** A great company can be a bad stock at the wrong price. Always flag if the variant perception is about the business quality OR the market's pricing of it.
- **Catalysts must be specific and dated where possible.** "Earnings growth" is not a catalyst. "Q3 earnings on July 25 where management may raise full-year guidance" is.
- **Cross-reference existing brain pages.** If the brain already has analysis on this ticker, incorporate and link to it.

## Entry Criteria

Run this skill when:
- User explicitly requests variant perception / contrarian analysis
- User asks "what is Wall Street missing" about a ticker
- User requests a deep-dive analysis that goes beyond surface-level research

Do NOT run for:
- Quick price checks or quotes
- Simple "what does this company do" questions
- General market commentary without a specific ticker

## Attribution

Prompt structure sourced from [@investingluc](https://x.com/investingluc/status/2066243670781694384) on X — one of his highest-value prompts for surfacing non-consensus investment insights.
