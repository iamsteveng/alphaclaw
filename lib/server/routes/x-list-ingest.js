const { X_WEB_SESSION_PROFILE_ID } = require("../x-web-session");

const buildIngestMessage = (listId) => `Run the x-list-ingest skill for X list ID ${listId}.`;

const findCronJob = (jobs) =>
  Array.isArray(jobs) ? (jobs.find((j) => j.name === "x-list-ingest") ?? null) : null;

// The cron runs x-list-crawl, which reads the x-twitter:web-session cookie
// profile. Without it every hourly run fails auth, so registration is gated on
// it being present — not just X_INGEST_LIST_ID.
const isWebSessionConfigured = (authProfiles) => {
  try {
    return !!authProfiles?.getProfile?.(X_WEB_SESSION_PROFILE_ID)?.access;
  } catch {
    return false;
  }
};

const buildCronAddParams = (listId, { deliveryChannel = "", deliveryTo = "" } = {}) => ({
  name: "x-list-ingest",
  agentId: "main",
  schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
  sessionTarget: "isolated",
  wakeMode: "now",
  enabled: false,
  payload: {
    kind: "agentTurn",
    message: buildIngestMessage(listId),
    thinking: "low",
    timeoutSeconds: 600,
  },
  delivery: deliveryChannel && deliveryTo
    ? { mode: "announce", channel: deliveryChannel, to: deliveryTo }
    : { mode: "none" },
});

const registerXListIngestRoutes = ({ app, requireAuth, gatewayRpc, authProfiles }) => {
  app.get("/api/x-list-ingest/status", requireAuth, async (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || null;
    const webSessionConfigured = isWebSessionConfigured(authProfiles);
    try {
      const result = await gatewayRpc("cron.list", { includeDisabled: true });
      res.json({ ok: true, envVarSet: !!listId, listId, webSessionConfigured, job: findCronJob(result?.jobs) });
    } catch {
      res.json({ ok: true, envVarSet: !!listId, listId, webSessionConfigured, job: null });
    }
  });

  app.post("/api/x-list-ingest/ensure", requireAuth, async (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || "";
    if (!listId) {
      return res.status(400).json({ ok: false, error: "X_INGEST_LIST_ID is not set" });
    }
    if (!isWebSessionConfigured(authProfiles)) {
      return res.status(400).json({
        ok: false,
        error: "X web session not configured — connect a cookie session in the Models → X card first",
      });
    }
    const deliveryChannel = String(req.body?.deliveryChannel || "").trim();
    const deliveryTo = String(req.body?.deliveryTo || "").trim();
    try {
      const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
      const existing = findCronJob(listResult?.jobs);
      if (existing) {
        return res.json({ ok: true, skipped: true, job: existing });
      }

      const added = await gatewayRpc("cron.add", buildCronAddParams(listId, { deliveryChannel, deliveryTo }), { timeoutMs: 30000 });
      const jobId = String(added?.id || "");
      if (!jobId) {
        return res.status(500).json({ ok: false, error: "Could not parse job ID from cron.add response" });
      }

      await gatewayRpc("cron.update", { id: jobId, patch: { enabled: true } }).catch(() => {});

      const listResult2 = await gatewayRpc("cron.list", { includeDisabled: true });
      res.json({ ok: true, registered: true, jobId, job: findCronJob(listResult2?.jobs) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });

  app.delete("/api/x-list-ingest", requireAuth, async (req, res) => {
    try {
      const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
      const existing = findCronJob(listResult?.jobs);
      if (!existing) {
        return res.json({ ok: true, skipped: true, reason: "not registered" });
      }
      await gatewayRpc("cron.remove", { id: String(existing.id || "") });
      res.json({ ok: true, removed: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });
};

module.exports = { registerXListIngestRoutes, isWebSessionConfigured };
