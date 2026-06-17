const path = require("path");
const { kRootDir, WORKSPACE_DIR } = require("../constants");

const kGbrainExportName = "gbrain-export";

const kGbrainBrainDir = path.join(WORKSPACE_DIR, "brain");
const kGbrainExportMessage =
  "GBrain export — execute now, no confirmation needed. " +
  `Step 1: Run HOME=${kRootDir} gbrain export --dir ${kGbrainBrainDir} to back up all pglite pages to flat files. ` +
  "Step 2: Run alphaclaw git-sync -m 'gbrain daily backup' to commit the exported files to the workspace GitHub repo. " +
  "Output ONLY a one-line summary of pages exported and whether the git sync succeeded — no questions, no follow-ups.";

const kJobs = [
  {
    name: kGbrainExportName,
    schedule: { kind: "cron", expr: "30 5 * * *", tz: "Asia/Hong_Kong" },
    message: kGbrainExportMessage,
    timeoutSeconds: 180,
  },
];

const findJob = (jobs, name) =>
  Array.isArray(jobs) ? (jobs.find((j) => j.name === name) ?? null) : null;

const buildCronAddParams = (job, { deliveryChannel = "", deliveryTo = "" } = {}) => ({
  name: job.name,
  agentId: "main",
  schedule: job.schedule,
  sessionTarget: "isolated",
  wakeMode: "now",
  enabled: false,
  payload: {
    kind: "agentTurn",
    message: job.message,
    thinking: "low",
    timeoutSeconds: job.timeoutSeconds,
  },
  delivery:
    deliveryChannel && deliveryTo
      ? { mode: "announce", channel: deliveryChannel, to: deliveryTo }
      : { mode: "none" },
});

const syncJob = async (gatewayRpc, job) => {
  const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
  const existing = findJob(listResult?.jobs, job.name);
  if (!existing) return { notFound: true };
  const jobId = String(existing.id || "");
  await gatewayRpc("cron.update", {
    id: jobId,
    patch: {
      payload: {
        kind: "agentTurn",
        message: job.message,
        thinking: "low",
        timeoutSeconds: job.timeoutSeconds,
      },
    },
  });
  return { synced: true, jobId };
};

const ensureJob = async (gatewayRpc, job, delivery) => {
  const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
  const existing = findJob(listResult?.jobs, job.name);
  if (existing) return { skipped: true, job: existing };

  const added = await gatewayRpc("cron.add", buildCronAddParams(job, delivery), { timeoutMs: 30000 });
  const jobId = String(added?.id || "");
  if (!jobId) throw new Error("Could not parse job ID from cron.add response");

  await gatewayRpc("cron.update", { id: jobId, patch: { enabled: true } }).catch(() => {});

  const listResult2 = await gatewayRpc("cron.list", { includeDisabled: true });
  return { registered: true, jobId, job: findJob(listResult2?.jobs, job.name) };
};

const registerGbrainCronRoutes = ({ app, requireAuth, gatewayRpc }) => {
  // GET /api/gbrain-crons/status — status of all gbrain cron jobs
  app.get("/api/gbrain-crons/status", requireAuth, async (req, res) => {
    try {
      const result = await gatewayRpc("cron.list", { includeDisabled: true });
      const jobs = kJobs.map((j) => ({ name: j.name, job: findJob(result?.jobs, j.name) }));
      res.json({ ok: true, jobs });
    } catch {
      res.json({ ok: true, jobs: kJobs.map((j) => ({ name: j.name, job: null })) });
    }
  });

  // POST /api/gbrain-crons/ensure — register all gbrain jobs (skip existing)
  app.post("/api/gbrain-crons/ensure", requireAuth, async (req, res) => {
    const deliveryChannel = String(req.body?.deliveryChannel || "").trim();
    const deliveryTo = String(req.body?.deliveryTo || "").trim();
    const delivery = { deliveryChannel, deliveryTo };
    try {
      const results = {};
      for (const job of kJobs) {
        results[job.name] = await ensureJob(gatewayRpc, job, delivery);
      }
      res.json({ ok: true, results });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });

  // POST /api/gbrain-crons/sync — update all job messages to current constants (without remove/re-add)
  app.post("/api/gbrain-crons/sync", requireAuth, async (req, res) => {
    try {
      const results = {};
      for (const job of kJobs) {
        results[job.name] = await syncJob(gatewayRpc, job);
      }
      res.json({ ok: true, results });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });

  // POST /api/gbrain-crons/run/:name — trigger a job manually
  app.post("/api/gbrain-crons/run/:name", requireAuth, async (req, res) => {
    const name = String(req.params.name || "").trim();
    const job = kJobs.find((j) => j.name === name);
    if (!job) return res.status(404).json({ ok: false, error: `Unknown job: ${name}` });
    try {
      const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
      const existing = findJob(listResult?.jobs, name);
      if (!existing) return res.status(404).json({ ok: false, error: `Job ${name} not registered` });
      const result = await gatewayRpc("cron.run", { id: String(existing.id || "") }, { timeoutMs: 600000 });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });

  // DELETE /api/gbrain-crons — remove all gbrain jobs
  app.delete("/api/gbrain-crons", requireAuth, async (req, res) => {
    try {
      const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
      const removed = [];
      for (const job of kJobs) {
        const existing = findJob(listResult?.jobs, job.name);
        if (existing) {
          await gatewayRpc("cron.remove", { id: String(existing.id || "") });
          removed.push(job.name);
        }
      }
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });
};

module.exports = { registerGbrainCronRoutes };
