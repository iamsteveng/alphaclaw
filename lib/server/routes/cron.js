const { parsePositiveInt } = require("../utils/number");

const kChatHistoryLimit = 200;
const kChatHistoryTimeoutMs = 12000;

const registerCronRoutes = ({
  app,
  requireAuth,
  cronService,
  gatewayRpc = null,
}) => {
  app.get("/api/cron/jobs", requireAuth, async (req, res) => {
    try {
      const sortBy = String(req.query.sortBy || "nextRunAtMs").trim();
      const sortDir = String(req.query.sortDir || "asc").trim();
      const result = await cronService.listJobs({ sortBy, sortDir });
      res.json({
        ok: true,
        storePath: result.storePath,
        jobs: result.jobs,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/status", requireAuth, async (req, res) => {
    try {
      const status = await cronService.getStatus();
      res.json({ ok: true, status });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/jobs/:id/runs", requireAuth, async (req, res) => {
    try {
      const runs = await cronService.getJobRuns({
        jobId: req.params.id,
        limit: parsePositiveInt(req.query.limit, 20),
        offset: Math.max(0, Number.parseInt(String(req.query.offset || "0"), 10) || 0),
        status: String(req.query.status || "all"),
        deliveryStatus: String(req.query.deliveryStatus || "all"),
        sortDir: String(req.query.sortDir || "desc"),
        query: String(req.query.query || ""),
      });
      res.json({
        ok: true,
        runs: {
          entries: runs.entries,
          total: runs.total,
          offset: runs.offset,
          limit: runs.limit,
          hasMore: runs.hasMore,
          nextOffset: runs.nextOffset,
        },
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/cron/jobs/:id/run", requireAuth, async (req, res) => {
    try {
      const result = await cronService.runJobNow(req.params.id);
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/cron/jobs/:id/enable", requireAuth, async (req, res) => {
    try {
      const result = await cronService.setJobEnabled({
        jobId: req.params.id,
        enabled: true,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/cron/jobs/:id/disable", requireAuth, async (req, res) => {
    try {
      const result = await cronService.setJobEnabled({
        jobId: req.params.id,
        enabled: false,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.put("/api/cron/jobs/:id/prompt", requireAuth, async (req, res) => {
    try {
      const message = String(req.body?.message || "");
      const result = await cronService.updateJobPrompt({
        jobId: req.params.id,
        message,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.put("/api/cron/jobs/:id/routing", requireAuth, async (req, res) => {
    try {
      const sessionTarget = String(req.body?.sessionTarget || "").trim();
      const wakeMode = String(req.body?.wakeMode || "").trim();
      const deliveryMode = String(req.body?.deliveryMode || "").trim();
      const deliveryChannel = String(req.body?.deliveryChannel || "").trim();
      const deliveryTo = String(req.body?.deliveryTo || "").trim();
      const result = await cronService.updateJobRouting({
        jobId: req.params.id,
        sessionTarget,
        wakeMode,
        deliveryMode,
        deliveryChannel,
        deliveryTo,
      });
      res.json({ ok: true, result: result.parsed || result.raw || {} });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/jobs/:id/usage", requireAuth, async (req, res) => {
    try {
      const days = parsePositiveInt(req.query.days, 0);
      const sinceMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      const usage = await cronService.getJobUsage({
        jobId: req.params.id,
        sinceMs,
      });
      res.json({ ok: true, usage });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });
  app.get("/api/cron/jobs/:id/trends", requireAuth, async (req, res) => {
    try {
      const trends = await cronService.getJobRunTrends({
        jobId: req.params.id,
        range: String(req.query.range || "7d"),
      });
      res.json({ ok: true, trends });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/usage/bulk", requireAuth, async (req, res) => {
    try {
      const days = parsePositiveInt(req.query.days, 0);
      const sinceMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      const usage = await cronService.getBulkJobUsage({ sinceMs });
      res.json({ ok: true, usage });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/runs/bulk", requireAuth, async (req, res) => {
    try {
      const sinceMs = Math.max(0, Number.parseInt(String(req.query.sinceMs || "0"), 10) || 0);
      const limitPerJob = parsePositiveInt(req.query.limitPerJob, 20);
      const runs = await cronService.getBulkJobRuns({
        sinceMs,
        limitPerJob,
        status: String(req.query.status || "all"),
        deliveryStatus: String(req.query.deliveryStatus || "all"),
        sortDir: String(req.query.sortDir || "desc"),
      });
      res.json({ ok: true, runs });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/cron/jobs/:id/runs/:runTs/chat-history", requireAuth, async (req, res) => {
    const tsRaw = req.params.runTs;
    if (!/^\d+$/.test(tsRaw)) {
      return res.status(400).json({ ok: false, error: "runTs must be a positive integer timestamp" });
    }
    const ts = Number.parseInt(tsRaw, 10);
    if (!Number.isSafeInteger(ts) || ts <= 0) {
      return res.status(400).json({ ok: false, error: "runTs must be a positive integer timestamp" });
    }
    let run;
    try {
      run = await cronService.getRunByTs({ jobId: req.params.id, ts });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    if (!run) {
      return res.status(404).json({ ok: false, error: "Run not found" });
    }
    const sessionKey = String(run.sessionKey || "").trim();
    if (!sessionKey) {
      return res.json({ ok: true, messages: [], sessionKey: "", run });
    }
    if (!gatewayRpc) {
      return res.status(503).json({ ok: false, error: "Gateway RPC not available" });
    }
    try {
      const history = await gatewayRpc(
        "chat.history",
        { sessionKey, limit: kChatHistoryLimit },
        { timeoutMs: kChatHistoryTimeoutMs },
      );
      const messages = Array.isArray(history?.messages)
        ? history.messages
        : Array.isArray(history?.history)
          ? history.history
          : Array.isArray(history?.items)
            ? history.items
            : [];
      return res.json({ ok: true, messages, sessionKey, run });
    } catch (error) {
      return res.status(502).json({ ok: false, error: error.message });
    }
  });
};

module.exports = { registerCronRoutes };
