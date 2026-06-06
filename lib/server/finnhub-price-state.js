const kDropThresholdPct = -5;

const createPriceState = () => ({ symbols: {} });

const applyTick = (state, { symbol, price }) => {
  const existing = state.symbols[symbol];
  if (!existing) {
    state.symbols[symbol] = {
      open: price,
      current: price,
      changePct: 0,
      dropFired: false,
      updatedAt: new Date().toISOString(),
    };
    return { symbol, dropDetected: false };
  }

  const changePct = ((price - existing.open) / existing.open) * 100;
  const dropDetected = !existing.dropFired && changePct < kDropThresholdPct;

  state.symbols[symbol] = {
    ...existing,
    current: price,
    changePct,
    dropFired: existing.dropFired || dropDetected,
    updatedAt: new Date().toISOString(),
  };

  return { symbol, dropDetected };
};

const getSnapshot = (state) => {
  const snapshot = {};
  for (const [symbol, entry] of Object.entries(state.symbols)) {
    snapshot[symbol] = {
      open: entry.open,
      current: entry.current,
      changePct: entry.changePct,
      updatedAt: entry.updatedAt,
    };
  }
  return snapshot;
};

// Matches bullet lines like "- AAPL (conviction: 4, direction: LONG)"
const kTickerLineRe = /^- ([A-Z]{1,5})\s+\(/;

const parseTickersFromGbrainPage = (output) => {
  if (!output) return [];
  const seen = new Set();
  for (const line of String(output).split("\n")) {
    const match = line.trim().match(kTickerLineRe);
    if (match) seen.add(match[1]);
  }
  return Array.from(seen);
};

module.exports = { createPriceState, applyTick, getSnapshot, parseTickersFromGbrainPage };
