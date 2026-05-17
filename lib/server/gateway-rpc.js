const WebSocket = require("ws");
const crypto = require("crypto");

const kGatewayProtocolVersion = 3;
// Same scopes as chat-ws.js kGatewayChatBridgeScopes — all operator scopes so
// shouldSkipLocalBackendSelfPairing fires and no device pairing is needed.
const kGatewayRpcScopes = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.talk.secrets",
];

// One-shot gateway RPC call using gateway-client/backend mode.
// Connects from loopback with the shared bearer token, which triggers
// shouldSkipLocalBackendSelfPairing in the gateway and skips device pairing
// entirely — no scope limits from device registration apply.
const callGatewayRpc = (method, params, { getGatewayPort, getGatewayToken, timeoutMs = 15000 } = {}) =>
  new Promise((resolve, reject) => {
    const port = typeof getGatewayPort === "function" ? getGatewayPort() : 18789;
    const token = typeof getGatewayToken === "function" ? getGatewayToken() : String(process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const connectId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    let settled = false;

    const settle = (result, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(
      () => settle(null, new Error(`Gateway RPC timeout: ${method}`)),
      timeoutMs,
    );

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw || "")); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "event" && String(msg.event || "") === "connect.challenge") {
        ws.send(JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: kGatewayProtocolVersion,
            maxProtocol: kGatewayProtocolVersion,
            client: { id: "gateway-client", version: "0.1.0", platform: process.platform, mode: "backend" },
            role: "operator",
            scopes: kGatewayRpcScopes,
            caps: [],
            commands: [],
            permissions: {},
            auth: { token },
            locale: "en-US",
            userAgent: "alphaclaw-rpc/0.1.0",
          },
        }));
        return;
      }

      if (msg.type === "res" && String(msg.id || "") === connectId) {
        if (!msg.ok) {
          settle(null, new Error(msg?.error?.message || msg?.error?.code || "Gateway connect failed"));
          return;
        }
        ws.send(JSON.stringify({ type: "req", id: callId, method, params }));
        return;
      }

      if (msg.type === "res" && String(msg.id || "") === callId) {
        if (!msg.ok) {
          settle(null, new Error(msg?.error?.message || msg?.error?.code || `${method} failed`));
        } else {
          settle(msg.payload ?? {});
        }
      }
    });

    ws.on("error", (err) => settle(null, new Error(err?.message || "Gateway WebSocket error")));
    ws.on("close", () => {
      if (!settled) settle(null, new Error(`Gateway closed during ${method}`));
    });
  });

// Creates a bound gateway RPC caller with injected port/token getters.
const createGatewayRpc = ({ getGatewayPort, getGatewayToken } = {}) =>
  (method, params, opts = {}) =>
    callGatewayRpc(method, params, { getGatewayPort, getGatewayToken, ...opts });

module.exports = { callGatewayRpc, createGatewayRpc };
