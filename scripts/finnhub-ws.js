#!/usr/bin/env node
/**
 * Finnhub WebSocket price tracker.
 *
 * Reads subscribed tickers from GBrain watchlist/current, streams real-time
 * trades from wss://ws.finnhub.io, writes price snapshots to
 * ~/.openclaw/finnhub-prices.json, and triggers an intraday audit when any
 * symbol drops >5% from its session open.
 *
 * Required env: FINNHUB_API_KEY, OPENCLAW_DIR (defaults to ~/.openclaw)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const WebSocket = require("ws");
const { createPriceState, applyTick, getSnapshot, parseTickersFromGbrainPage } = require("../lib/server/finnhub-price-state");

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(process.env.HOME || "/root", ".openclaw");
const PRICES_FILE = path.join(OPENCLAW_DIR, "finnhub-prices.json");
const WATCHLIST_FILE = path.join(OPENCLAW_DIR, "finnhub-watchlist.json");
const WS_URL = `wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`;
const RECONNECT_DELAY_MS = 5000;

if (!FINNHUB_API_KEY) {
  console.error("[finnhub-ws] FINNHUB_API_KEY is not set — exiting");
  process.exit(1);
}

const state = createPriceState();
let ws = null;
let reconnectTimer = null;
let currentTickers = [];

const readTickersFromGbrain = () => {
  try {
    const output = execSync("gbrain get watchlist/current 2>/dev/null", {
      encoding: "utf8",
      timeout: 10000,
    });
    return parseTickersFromGbrainPage(output);
  } catch {
    return [];
  }
};

const writeSnapshot = () => {
  try {
    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
    fs.writeFileSync(PRICES_FILE, JSON.stringify(getSnapshot(state), null, 2), "utf8");
  } catch (err) {
    console.error("[finnhub-ws] Failed to write prices file:", err.message);
  }
};

const writeWatchlistFile = (tickers) => {
  try {
    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(tickers, null, 2), "utf8");
  } catch (err) {
    console.error("[finnhub-ws] Failed to write watchlist file:", err.message);
  }
};

const triggerIntradayAudit = (symbol, changePct, currentPrice) => {
  const msg = `INTRADAY AUDIT TRIGGERED: ${symbol} dropped ${Math.abs(changePct).toFixed(2)}% from session open. Current price: ${currentPrice}. Read plans/${symbol} from GBrain and audit the plan immediately. Apply policy: check if invalidation level is breached, propose plan update or close. Deliver result to Steve via Telegram.`;
  console.log(`[finnhub-ws] Triggering intraday audit for ${symbol} (${changePct.toFixed(2)}%)`);
  try {
    // Option B: direct agent turn — delivers to Telegram if claw turn supports it
    execFileSync("claw", ["turn", "--agent", "main", "--message", msg], {
      timeout: 15000,
      stdio: "ignore",
    });
    console.log(`[finnhub-ws] Audit turn triggered for ${symbol}`);
  } catch (err) {
    console.error(`[finnhub-ws] claw turn failed (${err.message}) — writing audit-trigger.json for Option C fallback`);
    try {
      const triggerFile = path.join(OPENCLAW_DIR, "audit-trigger.json");
      fs.writeFileSync(
        triggerFile,
        JSON.stringify({ symbol, changePct, currentPrice, ts: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch (writeErr) {
      console.error("[finnhub-ws] Failed to write audit-trigger.json:", writeErr.message);
    }
  }
};

const subscribe = (socket, tickers) => {
  for (const symbol of tickers) {
    socket.send(JSON.stringify({ type: "subscribe", symbol }));
  }
};

const unsubscribeAll = (socket, tickers) => {
  for (const symbol of tickers) {
    try {
      socket.send(JSON.stringify({ type: "unsubscribe", symbol }));
    } catch {
      // best-effort on teardown
    }
  }
};

const handleTrade = (trades) => {
  for (const trade of trades) {
    const symbol = String(trade.s || "").trim();
    const price = Number(trade.p);
    if (!symbol || !Number.isFinite(price) || price <= 0) continue;

    const result = applyTick(state, { symbol, price });
    if (result.dropDetected) {
      const snap = getSnapshot(state);
      triggerIntradayAudit(symbol, snap[symbol].changePct, price);
    }
  }
  writeSnapshot();
};

const refreshTickers = (socket) => {
  const tickers = readTickersFromGbrain();
  if (tickers.length === 0) {
    console.log("[finnhub-ws] No tickers in GBrain watchlist/current — waiting");
    return;
  }
  const added = tickers.filter((t) => !currentTickers.includes(t));
  const removed = currentTickers.filter((t) => !tickers.includes(t));

  if (removed.length > 0) unsubscribeAll(socket, removed);
  if (added.length > 0) subscribe(socket, added);

  currentTickers = tickers;
  writeWatchlistFile(tickers);
  console.log(`[finnhub-ws] Subscribed to ${tickers.length} tickers:`, tickers.join(", "));
};

const connect = () => {
  console.log("[finnhub-ws] Connecting to Finnhub WebSocket...");
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("[finnhub-ws] Connected");
    refreshTickers(ws);
    // Refresh watchlist every 30 min in case watchlist-builder ran
    setInterval(() => refreshTickers(ws), 30 * 60 * 1000);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg.type === "trade" && Array.isArray(msg.data)) {
        handleTrade(msg.data);
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.on("error", (err) => {
    console.error("[finnhub-ws] WebSocket error:", err.message);
  });

  ws.on("close", (code) => {
    console.log(`[finnhub-ws] Disconnected (code ${code}) — reconnecting in ${RECONNECT_DELAY_MS}ms`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  });
};

process.on("SIGTERM", () => {
  console.log("[finnhub-ws] SIGTERM — shutting down");
  clearTimeout(reconnectTimer);
  if (ws) unsubscribeAll(ws, currentTickers);
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[finnhub-ws] SIGINT — shutting down");
  clearTimeout(reconnectTimer);
  if (ws) unsubscribeAll(ws, currentTickers);
  process.exit(0);
});

connect();
