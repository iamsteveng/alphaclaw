const { deriveCostBreakdown } = require("../../lib/server/cost-utils");

describe("server/cost-utils", () => {
  it("prices Claude Opus 4.7 including prompt cache tokens", () => {
    const breakdown = deriveCostBreakdown({
      provider: "anthropic",
      model: "anthropic/claude-opus-4-7",
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 800_000,
      cacheWriteTokens: 20_000,
    });

    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.inputCost).toBeCloseTo(0.5, 8);
    expect(breakdown.outputCost).toBeCloseTo(0.25, 8);
    expect(breakdown.cacheReadCost).toBeCloseTo(0.4, 8);
    expect(breakdown.cacheWriteCost).toBeCloseTo(0.125, 8);
    expect(breakdown.totalCost).toBeCloseTo(1.275, 8);
  });

  it("matches Claude Opus 4.7 dot-form model IDs", () => {
    const breakdown = deriveCostBreakdown({
      provider: "anthropic",
      model: "claude-opus-4.7",
      inputTokens: 1_000_000,
    });

    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.totalCost).toBeCloseTo(5, 8);
  });

  // The fallback map is scanned with `normalized.includes(key)` in insertion
  // order, so a mis-ordered map silently prices GPT-5.5/5.6 as plain GPT-5.
  it("prices GPT-5.5 from its own row rather than the gpt-5 row", () => {
    const breakdown = deriveCostBreakdown({
      provider: "openai",
      model: "openai/gpt-5.5",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });

    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.inputCost).toBeCloseTo(5.0, 8);
    expect(breakdown.outputCost).toBeCloseTo(30.0, 8);
    expect(breakdown.cacheReadCost).toBeCloseTo(0.5, 8);
    // the gpt-5 row would have priced input at 1.25
    expect(breakdown.inputCost).not.toBeCloseTo(1.25, 8);
  });

  it("prices GPT-5.6 Sol from its own row rather than the gpt-5 row", () => {
    const breakdown = deriveCostBreakdown({
      provider: "openai",
      model: "openai/gpt-5.6-sol",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });

    expect(breakdown.pricingFound).toBe(true);
    expect(breakdown.inputCost).toBeCloseTo(4.0, 8);
    expect(breakdown.outputCost).toBeCloseTo(20.0, 8);
    expect(breakdown.cacheReadCost).toBeCloseTo(0.4, 8);
    expect(breakdown.inputCost).not.toBeCloseTo(1.25, 8);
  });

  it("keeps the more specific OpenAI rows ahead of their prefixes", () => {
    const priceInputPerMillion = (model) =>
      deriveCostBreakdown({ provider: "openai", model, inputTokens: 1_000_000 })
        .inputCost;

    expect(priceInputPerMillion("openai/gpt-5.5-pro")).toBeCloseTo(30.0, 8);
    expect(priceInputPerMillion("openai/gpt-5.6-terra")).toBeCloseTo(2.0, 8);
    expect(priceInputPerMillion("openai/gpt-5.6-luna")).toBeCloseTo(0.2, 8);
    // bare gpt-5.6 is an alias for Sol
    expect(priceInputPerMillion("openai/gpt-5.6")).toBeCloseTo(4.0, 8);
    expect(priceInputPerMillion("openai/gpt-5.4-pro")).toBeCloseTo(30.0, 8);
    expect(priceInputPerMillion("openai/gpt-5.4-mini")).toBeCloseTo(0.75, 8);
    expect(priceInputPerMillion("openai/gpt-5.4-nano")).toBeCloseTo(0.2, 8);
    expect(priceInputPerMillion("openai/gpt-5.4")).toBeCloseTo(2.5, 8);
    expect(priceInputPerMillion("openai/gpt-4o-mini")).toBeCloseTo(0.15, 8);
    expect(priceInputPerMillion("openai/gpt-5")).toBeCloseTo(1.25, 8);
  });
});
