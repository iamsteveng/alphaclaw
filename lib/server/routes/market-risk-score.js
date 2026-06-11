const kJobName = "market-risk-score";
const kMessage =
  "Market risk score — execute now, no confirmation needed. And then report the summary.";
const kScheduleExpr = "15 8 * * *";
const kScheduleTz = "America/New_York";

const findCronJob = (jobs) =>
  Array.isArray(jobs) ? (jobs.find((j) => j.name === kJobName) ?? null) : null;

const buildCronAddParams = ({ deliveryChannel = "", deliveryTo = "" } = {}) => ({
  name: kJobName,
  agentId: "main",
  schedule: { kind: "cron", expr: kScheduleExpr, tz: kScheduleTz },
  sessionTarget: "isolated",
  wakeMode: "now",
  enabled: false,
  payload: {
    kind: "agentTurn",
    message: kMessage,
    timeoutSeconds: 300,
  },
  delivery: deliveryChannel && deliveryTo
    ? { mode: "announce", channel: deliveryChannel, to: deliveryTo }
    : { mode: "none" },
});

const registerMarketRiskScoreRoutes = ({ app, requireAuth, gatewayRpc }) => {
  app.get("/api/market-risk-score/status", requireAuth, async (req, res) => {
    try {
      const result = await gatewayRpc("cron.list", { includeDisabled: true });
      res.json({ ok: true, job: findCronJob(result?.jobs) });
    } catch {
      res.json({ ok: true, job: null });
    }
  });

  app.post("/api/market-risk-score/ensure", requireAuth, async (req, res) => {
    const deliveryChannel = String(req.body?.deliveryChannel || "").trim();
    const deliveryTo = String(req.body?.deliveryTo || "").trim();
    try {
      const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
      const existing = findCronJob(listResult?.jobs);
      if (existing) {
        return res.json({ ok: true, skipped: true, job: existing });
      }

      const added = await gatewayRpc("cron.add", buildCronAddParams({ deliveryChannel, deliveryTo }), { timeoutMs: 30000 });
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

  app.delete("/api/market-risk-score", requireAuth, async (req, res) => {
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

module.exports = { registerMarketRiskScoreRoutes };
