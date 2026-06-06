"use strict";

const fs = require("fs");
const https = require("https");
const path = require("path");

const kPollIntervalMs = 5 * 60 * 1000;

// DST-aware ET check: only poll during 9:20 AM–12:40 PM ET on weekdays.
// Uses Intl to resolve the America/New_York offset correctly in both EST and EDT.
const isMarketWindow = () => {
  const now = new Date();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return false;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const minute = parseInt(parts.find((p) => p.type === "minute").value, 10);
  const etMinutes = hour * 60 + minute;
  return etMinutes >= 9 * 60 + 20 && etMinutes <= 12 * 60 + 40;
};

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (err) { reject(new Error(`JSON parse failed: ${err.message}`)); }
        });
      })
      .on("error", reject);
  });

const readWatchlist = (watchlistFile) => {
  try {
    const tickers = JSON.parse(fs.readFileSync(watchlistFile, "utf8"));
    return Array.isArray(tickers) ? tickers : [];
  } catch {
    return [];
  }
};

const loadExistingPrices = (pricesFile) => {
  try { return JSON.parse(fs.readFileSync(pricesFile, "utf8")) || {}; }
  catch { return {}; }
};

const writePrices = (pricesFile, prices) => {
  try {
    fs.mkdirSync(path.dirname(pricesFile), { recursive: true });
    fs.writeFileSync(pricesFile, JSON.stringify(prices, null, 2), "utf8");
  } catch (err) {
    console.error("[finnhub-poller] Failed to write prices:", err.message);
  }
};

const fetchQuote = async (symbol, apiKey) => {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  // c = current, o = open, dp = change%, t = unix timestamp
  if (!data || typeof data.c !== "number" || data.c === 0) return null;
  return {
    open: data.o,
    current: data.c,
    changePct: typeof data.dp === "number" ? data.dp : 0,
    updatedAt: new Date().toISOString(),
  };
};

const createFinnhubPoller = ({ openclawDir }) => {
  const watchlistFile = path.join(openclawDir, "finnhub-watchlist.json");
  const pricesFile = path.join(openclawDir, "finnhub-prices.json");
  let timer = null;

  const poll = async () => {
    if (!isMarketWindow()) {
      console.log("[finnhub-poller] Outside market window — skipping poll");
      return;
    }
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) {
      console.log("[finnhub-poller] FINNHUB_API_KEY not set — skipping poll");
      return;
    }

    const tickers = readWatchlist(watchlistFile);
    if (tickers.length === 0) {
      console.log("[finnhub-poller] Watchlist empty — skipping poll");
      return;
    }

    const prices = loadExistingPrices(pricesFile);
    let updated = 0;

    for (const ticker of tickers) {
      try {
        const quote = await fetchQuote(ticker, apiKey);
        if (quote) { prices[ticker] = quote; updated++; }
      } catch (err) {
        console.error(`[finnhub-poller] ${ticker}: ${err.message}`);
      }
    }

    if (updated > 0) {
      writePrices(pricesFile, prices);
      console.log(`[finnhub-poller] Updated ${updated}/${tickers.length} tickers`);
    } else {
      console.log(`[finnhub-poller] No valid quotes for ${tickers.length} tickers (market closed or bad key?)`);
    }
  };

  const start = () => {
    if (timer) return;
    console.log("[finnhub-poller] Starting — polling Finnhub every 5 minutes");
    poll().catch((err) => console.error("[finnhub-poller] Initial poll error:", err.message));
    timer = setInterval(() => {
      poll().catch((err) => console.error("[finnhub-poller] Poll error:", err.message));
    }, kPollIntervalMs);
    if (timer.unref) timer.unref();
  };

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
    console.log("[finnhub-poller] Stopped");
  };

  return { start, stop };
};

module.exports = { createFinnhubPoller };
