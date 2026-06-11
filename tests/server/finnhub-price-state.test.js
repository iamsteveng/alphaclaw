const { createPriceState, applyTick, getSnapshot, parseTickersFromGbrainPage } = require("../../lib/server/finnhub-price-state");

describe("finnhub-price-state", () => {
  describe("open price", () => {
    it("first tick sets open price for a symbol", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 150 });
      const snap = getSnapshot(state);
      expect(snap.AAPL.open).toBe(150);
    });

    it("subsequent ticks do not overwrite open price", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 150 });
      applyTick(state, { symbol: "AAPL", price: 155 });
      applyTick(state, { symbol: "AAPL", price: 140 });
      const snap = getSnapshot(state);
      expect(snap.AAPL.open).toBe(150);
    });

    it("tracks open independently per symbol", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 150 });
      applyTick(state, { symbol: "TSLA", price: 200 });
      applyTick(state, { symbol: "AAPL", price: 160 });
      const snap = getSnapshot(state);
      expect(snap.AAPL.open).toBe(150);
      expect(snap.TSLA.open).toBe(200);
    });
  });

  describe("changePct calculation", () => {
    it("calculates positive changePct correctly", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      applyTick(state, { symbol: "AAPL", price: 110 });
      const snap = getSnapshot(state);
      expect(snap.AAPL.changePct).toBeCloseTo(10);
    });

    it("calculates negative changePct correctly", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      applyTick(state, { symbol: "AAPL", price: 94 });
      const snap = getSnapshot(state);
      expect(snap.AAPL.changePct).toBeCloseTo(-6);
    });

    it("changePct is zero on first tick", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      const snap = getSnapshot(state);
      expect(snap.AAPL.changePct).toBe(0);
    });
  });

  describe("drop detection", () => {
    it("does not fire at exactly -5.0%", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      const result = applyTick(state, { symbol: "AAPL", price: 95 });
      expect(result.dropDetected).toBe(false);
    });

    it("fires at -5.01%", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      const result = applyTick(state, { symbol: "AAPL", price: 94.98 });
      expect(result.dropDetected).toBe(true);
    });

    it("does not fire for gains", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      const result = applyTick(state, { symbol: "AAPL", price: 110 });
      expect(result.dropDetected).toBe(false);
    });

    it("fires only once per symbol per session", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      const first = applyTick(state, { symbol: "AAPL", price: 90 });
      const second = applyTick(state, { symbol: "AAPL", price: 85 });
      expect(first.dropDetected).toBe(true);
      expect(second.dropDetected).toBe(false);
    });

    it("drop on one symbol does not affect another", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 100 });
      applyTick(state, { symbol: "TSLA", price: 200 });
      applyTick(state, { symbol: "AAPL", price: 90 }); // AAPL drops 10% — fires for AAPL
      const result = applyTick(state, { symbol: "TSLA", price: 192 }); // TSLA only -4% — should not fire
      expect(result.dropDetected).toBe(false);
    });
  });

  describe("snapshot shape", () => {
    it("snapshot includes open, current, changePct, updatedAt for each symbol", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 150 });
      applyTick(state, { symbol: "AAPL", price: 155 });
      const snap = getSnapshot(state);
      expect(snap.AAPL).toMatchObject({
        open: 150,
        current: 155,
        changePct: expect.any(Number),
        updatedAt: expect.any(String),
      });
    });

    it("updatedAt is a valid ISO-8601 string", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 150 });
      const snap = getSnapshot(state);
      expect(() => new Date(snap.AAPL.updatedAt).toISOString()).not.toThrow();
    });

    it("snapshot contains all tracked symbols", () => {
      const state = createPriceState();
      applyTick(state, { symbol: "AAPL", price: 150 });
      applyTick(state, { symbol: "TSLA", price: 200 });
      applyTick(state, { symbol: "NVDA", price: 900 });
      const snap = getSnapshot(state);
      expect(Object.keys(snap)).toEqual(expect.arrayContaining(["AAPL", "TSLA", "NVDA"]));
    });
  });

  describe("parseTickersFromGbrainPage", () => {
    const samplePage = `---
type: watchlist
title: Current
updated_at: '2026-06-04T11:30:00.000Z'
---

## Active Tickers

- AAPL (conviction: 4, direction: LONG)
- TSLA (conviction: 3, direction: SHORT)
- NVDA (conviction: 5, direction: LONG)`;

    it("extracts ticker symbols from gbrain get output", () => {
      const tickers = parseTickersFromGbrainPage(samplePage);
      expect(tickers).toEqual(["AAPL", "TSLA", "NVDA"]);
    });

    it("returns empty array for empty or missing page output", () => {
      expect(parseTickersFromGbrainPage("")).toEqual([]);
      expect(parseTickersFromGbrainPage(null)).toEqual([]);
      expect(parseTickersFromGbrainPage(undefined)).toEqual([]);
    });

    it("returns empty array when page has no ticker lines", () => {
      const noTickers = `---\ntype: watchlist\n---\n\nNo tickers yet.`;
      expect(parseTickersFromGbrainPage(noTickers)).toEqual([]);
    });

    it("ignores non-ticker bullet lines", () => {
      const mixed = `## Active Tickers\n\n- AAPL (conviction: 4, direction: LONG)\n- some notes here\n- MSFT (conviction: 2, direction: LONG)`;
      const tickers = parseTickersFromGbrainPage(mixed);
      expect(tickers).toEqual(["AAPL", "MSFT"]);
    });

    it("deduplicates repeated tickers", () => {
      const dupes = `- AAPL (conviction: 4, direction: LONG)\n- AAPL (conviction: 3, direction: SHORT)`;
      const tickers = parseTickersFromGbrainPage(dupes);
      expect(tickers).toEqual(["AAPL"]);
    });
  });
});
