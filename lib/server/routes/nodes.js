const crypto = require("crypto");
const { parseJsonObjectFromNoisyOutput } = require("../utils/json");
const { quoteShellArg } = require("../utils/shell");
const {
  readExecApprovalsConfig,
  writeExecApprovalsConfig,
  resolveInstalledOpenclawVersion,
  usesSqliteExecApprovals,
} = require("../exec-defaults-config");

const kAllowedExecHosts = new Set(["gateway", "node"]);
const kAllowedExecSecurity = new Set(["deny", "allowlist", "full"]);
const kAllowedExecAsk = new Set(["off", "on-miss", "always"]);
const kSafeNodeIdPattern = /^[\w\-:.]+$/;
const kNodeBrowserInvokeTimeoutMs = 30000;
const kNodeBrowserCliTimeoutMs = 35000;
const kDefaultNodeRouteCliTimeoutMs = 12000;
const kDefaultNodesStatusCliTimeoutMs = 12000;
const kDefaultNodesPendingCliTimeoutMs = 12000;
const kDefaultNodeApprovalsCliTimeoutMs = 12000;

// AlphaClaw only ever managed the wildcard agent's allowlist, on both the
// legacy JSON file and the 2.0 SQLite store.
const kWildcardAgentId = "*";

const quoteCliArg = (value) => quoteShellArg(value, { strategy: "single" });

const resolveCliTimeoutMs = (envName, fallbackMs, env = process.env) => {
  const parsed = Number(env[envName]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.round(parsed);
};

const resolveNodeCliTimeouts = (env = process.env) => ({
  route: resolveCliTimeoutMs(
    "ALPHACLAW_NODE_ROUTE_TIMEOUT_MS",
    kDefaultNodeRouteCliTimeoutMs,
    env,
  ),
  status: resolveCliTimeoutMs(
    "ALPHACLAW_NODES_STATUS_TIMEOUT_MS",
    kDefaultNodesStatusCliTimeoutMs,
    env,
  ),
  pending: resolveCliTimeoutMs(
    "ALPHACLAW_NODES_PENDING_TIMEOUT_MS",
    kDefaultNodesPendingCliTimeoutMs,
    env,
  ),
  approvals: resolveCliTimeoutMs(
    "ALPHACLAW_NODE_APPROVALS_TIMEOUT_MS",
    kDefaultNodeApprovalsCliTimeoutMs,
    env,
  ),
});

// Failure interpretation (timeout vs stderr vs exit code) lives in clawCmd's
// failureMessage — this only supplies the route-specific fallback.
const formatCliFailure = ({ result, fallback }) =>
  result?.failureMessage || fallback;

const normalizeExecAsk = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "on") return "on-miss";
  return normalized;
};

const buildDefaultExecConfig = () => ({
  host: "gateway",
  security: "allowlist",
  ask: "on-miss",
  node: "",
});

const parseNodesStatus = (stdout) => {
  const parsed = parseJsonObjectFromNoisyOutput(stdout) || {};
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const pending = Array.isArray(parsed.pending)
    ? parsed.pending
    : nodes.filter((entry) => entry && entry.paired === false);
  return { nodes, pending };
};

const parseNodesPending = (stdout) => {
  const parsed = parseJsonObjectFromNoisyOutput(stdout) || {};
  const list = Array.isArray(parsed.pending)
    ? parsed.pending
    : Array.isArray(parsed.requests)
      ? parsed.requests
      : Array.isArray(parsed.nodes)
        ? parsed.nodes
        : [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const requestId = String(entry.requestId || entry.id || "").trim();
      const nodeId = String(entry.nodeId || requestId).trim();
      if (!nodeId) return null;
      return {
        ...entry,
        id: requestId || nodeId,
        nodeId,
        paired: false,
      };
    })
    .filter(Boolean);
};

const parseNodeBrowserStatus = (stdout) => {
  const parsed = parseJsonObjectFromNoisyOutput(stdout) || {};
  const payload =
    parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {};
  const payloadResult = payload.result;
  let decodedResult = payloadResult;
  if (typeof decodedResult === "string") {
    const parsedResult = parseJsonObjectFromNoisyOutput(decodedResult);
    decodedResult = parsedResult || decodedResult;
  }
  if (decodedResult && typeof decodedResult === "object" && decodedResult.result) {
    const nestedResult = decodedResult.result;
    if (nestedResult && typeof nestedResult === "object") {
      decodedResult = nestedResult;
    }
  }
  return decodedResult && typeof decodedResult === "object" ? decodedResult : null;
};

const ensureWildcardAgent = (file) => {
  const agents = file.agents && typeof file.agents === "object" ? file.agents : {};
  const wildcard =
    agents["*"] && typeof agents["*"] === "object" ? agents["*"] : {};
  const allowlist = Array.isArray(wildcard.allowlist) ? wildcard.allowlist : [];
  agents["*"] = { ...wildcard, allowlist };
  return { ...file, version: 1, agents };
};

// OpenClaw 2026.8.1+ keeps exec approvals in SQLite and treats a policy-bearing
// `<openclawDir>/exec-approvals.json` as a blocking legacy store: writing it
// makes every later `openclaw` CLI call fail with "Legacy exec approvals exist
// at ...". `openclaw approvals` is the only supported read/write path there, so
// these helpers build the CLI form of what the legacy routes did by hand.
// `--` guards a pattern that starts with a dash from being parsed as an option.
const buildApprovalsAllowlistCommand = (action, pattern) =>
  `approvals allowlist ${action} --agent ${quoteCliArg(kWildcardAgentId)} --json -- ${quoteCliArg(pattern)}`;

const findAllowlistEntryByPattern = (allowlist, pattern) =>
  allowlist.find((entry) => String(entry?.pattern || "").trim() === pattern);

const resolveSetupUiBaseUrl = (req) => {
  const explicit = String(
    process.env.ALPHACLAW_SETUP_URL ||
      process.env.ALPHACLAW_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.URL ||
      "",
  )
    .trim()
    .replace(/\/+$/, "");
  if (explicit) return explicit;

  const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayPublicDomain) {
    return `https://${railwayPublicDomain}`;
  }

  const railwayStaticUrl = String(process.env.RAILWAY_STATIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
  if (railwayStaticUrl) return railwayStaticUrl;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  const reqProtocol = req.protocol || "http";
  const reqHost = req.get("host");
  if (reqHost) {
    return `${reqProtocol}://${reqHost}`;
  }

  return "http://localhost:3000";
};

const parseBaseUrlParts = (baseUrl) => {
  try {
    const parsed = new URL(baseUrl);
    const tls = parsed.protocol === "https:";
    const port =
      Number(parsed.port) || (tls ? 443 : 80);
    return {
      baseUrl: parsed.origin,
      host: parsed.hostname,
      port,
      tls,
    };
  } catch {
    return {
      baseUrl: "http://localhost:3000",
      host: "localhost",
      port: 3000,
      tls: false,
    };
  }
};

const registerNodeRoutes = ({
  app,
  clawCmd,
  openclawDir,
  gatewayToken = "",
  fsModule,
  openclawVersion = resolveInstalledOpenclawVersion(),
}) => {
  const cliTimeouts = resolveNodeCliTimeouts();
  const sqliteExecApprovals = usesSqliteExecApprovals(openclawVersion);

  // Both the GET route and the id -> pattern lookup the DELETE route needs read
  // the same snapshot; `approvals get --json` returns the approvals document
  // under `file`, in the exact shape the legacy JSON file had.
  const readSqliteApprovals = async () => {
    const result = await clawCmd("approvals get --json", {
      quiet: true,
      timeoutMs: cliTimeouts.approvals,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: formatCliFailure({
          result,
          fallback: "Could not load exec approvals",
        }),
      };
    }
    const parsed = parseJsonObjectFromNoisyOutput(result.stdout) || {};
    const file =
      parsed.file && typeof parsed.file === "object" && !Array.isArray(parsed.file)
        ? parsed.file
        : {};
    return { ok: true, approvals: ensureWildcardAgent(file) };
  };

  app.get("/api/nodes", async (_req, res) => {
    const statusResult = await clawCmd("nodes status --json", {
      quiet: true,
      timeoutMs: cliTimeouts.status,
    });
    if (!statusResult.ok) {
      return res.status(500).json({
        ok: false,
        error: formatCliFailure({
          result: statusResult,
          fallback: "Could not load nodes status",
        }),
      });
    }
    const status = parseNodesStatus(statusResult.stdout);
    const pendingResult = await clawCmd("nodes pending --json", {
      quiet: true,
      timeoutMs: cliTimeouts.pending,
    });
    const pending = pendingResult.ok
      ? parseNodesPending(pendingResult.stdout)
      : status.pending;
    const pendingById = new Map();
    for (const entry of pending) {
      const nodeId = String(entry?.nodeId || entry?.id || "").trim();
      if (!nodeId || pendingById.has(nodeId)) continue;
      pendingById.set(nodeId, entry);
    }
    return res.json({
      ok: true,
      nodes: status.nodes,
      pending: Array.from(pendingById.values()),
    });
  });

  app.post("/api/nodes/:id/approve", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const result = await clawCmd(`nodes approve ${quoteCliArg(nodeId)}`);
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.stderr || "Could not approve node",
      });
    }
    return res.json({ ok: true });
  });

  app.post("/api/nodes/:id/route", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const commands = [
      "config set tools.exec.host 'node'",
      "config set tools.exec.security 'allowlist'",
      "config set tools.exec.ask 'on-miss'",
      `config set tools.exec.node ${quoteCliArg(nodeId)}`,
    ];
    for (const command of commands) {
      const result = await clawCmd(command, {
        quiet: true,
        timeoutMs: cliTimeouts.route,
      });
      if (!result.ok) {
        return res.status(500).json({
          ok: false,
          error: formatCliFailure({
            result,
            fallback: `Could not apply node routing (${command})`,
          }),
        });
      }
    }
    return res.json({ ok: true, restartRequired: true, nodeId });
  });

  app.delete("/api/nodes/:id", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const result = await clawCmd(`devices remove ${quoteCliArg(nodeId)}`, {
      quiet: true,
    });
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.stderr || "Could not remove node",
      });
    }
    return res.json({ ok: true, nodeId });
  });

  app.get("/api/nodes/connect-info", async (req, res) => {
    const baseUrl = resolveSetupUiBaseUrl(req);
    const parsed = parseBaseUrlParts(baseUrl);
    return res.json({
      ok: true,
      baseUrl: parsed.baseUrl,
      gatewayHost: parsed.host,
      gatewayPort: parsed.port,
      gatewayToken: String(gatewayToken || ""),
      tls: parsed.tls,
    });
  });

  app.get("/api/nodes/:id/browser-status", async (req, res) => {
    const nodeId = String(req.params.id || "").trim();
    if (!nodeId || !kSafeNodeIdPattern.test(nodeId)) {
      return res.status(400).json({ ok: false, error: "Invalid node id" });
    }
    const profile = String(req.query?.profile || "user").trim() || "user";
    const params = JSON.stringify({
      method: "GET",
      path: "/",
      query: { profile },
    });
    const result = await clawCmd(
      `nodes invoke --node ${quoteCliArg(nodeId)} --command browser.proxy --params ${quoteCliArg(params)} --invoke-timeout ${kNodeBrowserInvokeTimeoutMs} --json`,
      { quiet: true, timeoutMs: kNodeBrowserCliTimeoutMs },
    );
    if (!result.ok) {
      return res.status(500).json({
        ok: false,
        error: result.stderr || "Could not probe node browser status",
      });
    }
    const status = parseNodeBrowserStatus(result.stdout);
    if (!status) {
      return res.status(500).json({
        ok: false,
        error: "Could not parse node browser status",
      });
    }
    return res.json({ ok: true, status, profile });
  });

  app.get("/api/nodes/exec-config", async (_req, res) => {
    const result = await clawCmd("config get tools.exec --json", { quiet: true });
    if (!result.ok) {
      return res.json({ ok: true, config: buildDefaultExecConfig() });
    }
    const parsed = parseJsonObjectFromNoisyOutput(result.stdout) || {};
    const config = buildDefaultExecConfig();
    const host = String(parsed.host || "").trim().toLowerCase();
    const security = String(parsed.security || "").trim().toLowerCase();
    const ask = normalizeExecAsk(parsed.ask);
    const node = String(parsed.node || "").trim();
    if (kAllowedExecHosts.has(host)) config.host = host;
    if (kAllowedExecSecurity.has(security)) config.security = security;
    if (kAllowedExecAsk.has(ask)) config.ask = ask;
    if (node) config.node = node;
    return res.json({ ok: true, config });
  });

  app.post("/api/nodes/exec-config", async (req, res) => {
    const body = req.body || {};
    const host = String(body.host || "").trim().toLowerCase();
    const security = String(body.security || "").trim().toLowerCase();
    const ask = normalizeExecAsk(body.ask);
    const node = String(body.node || "").trim();
    if (!kAllowedExecHosts.has(host)) {
      return res.status(400).json({ ok: false, error: "Invalid exec host" });
    }
    if (!kAllowedExecSecurity.has(security)) {
      return res.status(400).json({ ok: false, error: "Invalid exec security" });
    }
    if (!kAllowedExecAsk.has(ask)) {
      return res.status(400).json({ ok: false, error: "Invalid exec ask mode" });
    }
    if (host === "node" && !node) {
      return res
        .status(400)
        .json({ ok: false, error: "Node target is required when host is node" });
    }

    const commands = [
      `config set tools.exec.host ${quoteCliArg(host)}`,
      `config set tools.exec.security ${quoteCliArg(security)}`,
      `config set tools.exec.ask ${quoteCliArg(ask)}`,
      host === "node"
        ? `config set tools.exec.node ${quoteCliArg(node)}`
        : "config set tools.exec.node ''",
    ];

    for (const command of commands) {
      const result = await clawCmd(command);
      if (!result.ok) {
        return res.status(500).json({
          ok: false,
          error: result.stderr || `Could not apply exec config (${command})`,
        });
      }
    }

    return res.json({ ok: true, restartRequired: true });
  });

  app.get("/api/nodes/exec-approvals", async (_req, res) => {
    if (sqliteExecApprovals) {
      const snapshot = await readSqliteApprovals();
      if (!snapshot.ok) {
        return res.status(500).json({ ok: false, error: snapshot.error });
      }
      return res.json({
        ok: true,
        file: snapshot.approvals,
        allowlist: snapshot.approvals.agents[kWildcardAgentId].allowlist,
      });
    }
    const approvals = ensureWildcardAgent(
      readExecApprovalsConfig({ fsModule, openclawDir }),
    );
    const allowlist = approvals?.agents?.["*"]?.allowlist || [];
    return res.json({
      ok: true,
      file: approvals,
      allowlist,
    });
  });

  app.post("/api/nodes/exec-approvals/allowlist", async (req, res) => {
    const pattern = String(req.body?.pattern || "").trim();
    if (!pattern) {
      return res.status(400).json({ ok: false, error: "pattern is required" });
    }
    if (sqliteExecApprovals) {
      const snapshot = await readSqliteApprovals();
      if (!snapshot.ok) {
        return res.status(500).json({ ok: false, error: snapshot.error });
      }
      const existing = findAllowlistEntryByPattern(
        snapshot.approvals.agents[kWildcardAgentId].allowlist,
        pattern,
      );
      if (existing) {
        return res.json({ ok: true, entry: existing, unchanged: true });
      }
      const result = await clawCmd(buildApprovalsAllowlistCommand("add", pattern), {
        quiet: true,
        timeoutMs: cliTimeouts.approvals,
      });
      if (!result.ok) {
        return res.status(500).json({
          ok: false,
          error: formatCliFailure({
            result,
            fallback: "Could not add allowlist pattern",
          }),
        });
      }
      // The CLI mints the entry id and `lastUsedAt`, and echoes the updated
      // document, so the entry is read back rather than synthesized here.
      const parsed = parseJsonObjectFromNoisyOutput(result.stdout) || {};
      const updated = ensureWildcardAgent(
        parsed.file && typeof parsed.file === "object" && !Array.isArray(parsed.file)
          ? parsed.file
          : {},
      );
      const entry =
        findAllowlistEntryByPattern(
          updated.agents[kWildcardAgentId].allowlist,
          pattern,
        ) || { pattern };
      return res.json({ ok: true, entry });
    }
    const approvals = ensureWildcardAgent(
      readExecApprovalsConfig({ fsModule, openclawDir }),
    );
    const allowlist = approvals.agents["*"].allowlist;
    const existing = allowlist.find(
      (entry) => String(entry?.pattern || "").trim() === pattern,
    );
    if (existing) {
      return res.json({ ok: true, entry: existing, unchanged: true });
    }
    const entry = {
      pattern,
      id: crypto.randomUUID(),
      lastUsedAt: Date.now(),
    };
    approvals.agents["*"].allowlist = [...allowlist, entry];
    writeExecApprovalsConfig({ fsModule, openclawDir, file: approvals });
    return res.json({ ok: true, entry });
  });

  app.delete("/api/nodes/exec-approvals/allowlist/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: "id is required" });
    }
    if (sqliteExecApprovals) {
      // The dashboard deletes by entry id but the CLI removes by pattern, so
      // the id has to be resolved against the current snapshot first.
      const snapshot = await readSqliteApprovals();
      if (!snapshot.ok) {
        return res.status(500).json({ ok: false, error: snapshot.error });
      }
      const entry = snapshot.approvals.agents[kWildcardAgentId].allowlist.find(
        (candidate) => String(candidate?.id || "") === id,
      );
      if (!entry) {
        return res.status(404).json({ ok: false, error: "Allowlist entry not found" });
      }
      const pattern = String(entry.pattern || "").trim();
      if (!pattern) {
        return res.status(500).json({
          ok: false,
          error: "Allowlist entry has no pattern to remove",
        });
      }
      const result = await clawCmd(
        buildApprovalsAllowlistCommand("remove", pattern),
        { quiet: true, timeoutMs: cliTimeouts.approvals },
      );
      if (!result.ok) {
        return res.status(500).json({
          ok: false,
          error: formatCliFailure({
            result,
            fallback: "Could not remove allowlist pattern",
          }),
        });
      }
      return res.json({ ok: true });
    }
    const approvals = ensureWildcardAgent(
      readExecApprovalsConfig({ fsModule, openclawDir }),
    );
    const allowlist = approvals.agents["*"].allowlist;
    const nextAllowlist = allowlist.filter((entry) => String(entry?.id || "") !== id);
    if (nextAllowlist.length === allowlist.length) {
      return res.status(404).json({ ok: false, error: "Allowlist entry not found" });
    }
    approvals.agents["*"].allowlist = nextAllowlist;
    writeExecApprovalsConfig({ fsModule, openclawDir, file: approvals });
    return res.json({ ok: true });
  });
};

module.exports = {
  registerNodeRoutes,
};
