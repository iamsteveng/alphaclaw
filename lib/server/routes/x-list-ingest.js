const buildIngestMessage = (listId) => `Run the x-list-ingest skill for X list ID ${listId}.`;

const findCronJob = (jobs) =>
  Array.isArray(jobs) ? (jobs.find((j) => j.name === "x-list-ingest") ?? null) : null;

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

const registerXListIngestRoutes = ({ app, requireAuth, gatewayRpc }) => {
  app.get("/api/x-list-ingest/status", requireAuth, async (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || null;
    try {
      const result = await gatewayRpc("cron.list", { includeDisabled: true });
      res.json({ ok: true, envVarSet: !!listId, listId, job: findCronJob(result?.jobs) });
    } catch {
      res.json({ ok: true, envVarSet: !!listId, listId, job: null });
    }
  });

  app.post("/api/x-list-ingest/ensure", requireAuth, async (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || "";
    if (!listId) {
      return res.status(400).json({ ok: false, error: "X_INGEST_LIST_ID is not set" });
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

module.exports = { registerXListIngestRoutes };
