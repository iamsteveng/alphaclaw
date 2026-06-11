const kWatchlistBuilderName = "trading-watchlist-builder";
const kPriceReportName = "trading-price-report";
const kEodLoopName = "trading-eod-loop";

const kWatchlistBuilderMessage =
  "Watchlist builder — execute now, no confirmation needed. Audit trading watchlist.";

const kPriceReportMessage =
  "Price report — execute now, no confirmation needed.\n\nStep 0 — Check market status: Run: curl -s 'https://finnhub.io/api/v1/stock/market-status?exchange=US&token=$FINNHUB_API_KEY' — parse the JSON. If isOpen is false, output 'Market closed — skipping price report' and stop immediately.\n\nStep 1 — Fetch all plan data and prices in one shell command. Run exactly:\nfor slug in $(gbrain list --type trading-plan --limit 500 2>/dev/null); do echo \"=== $slug ===\"; gbrain get \"$slug\" 2>/dev/null; done; echo \"=== PRICES ===\"; cat /data/.openclaw/finnhub-prices.json 2>/dev/null || echo \"no prices file\"\n\nStep 2 — From the output above: collect every plan where the frontmatter field status is exactly \"active\". For each active plan read: ticker, direction, entry, target, invalidation, rr_ratio, setup_rating. Then look up current_price for that ticker in the PRICES JSON. Compute distance = abs(current_price - entry) / entry * 100. If the ticker is not in the prices JSON, show distance as \"n/a\".\n\nStep 3 — Plans where distance <= 2% get an APPROACHING alert.\n\nStep 4 — Output ONLY the formatted Telegram report — no questions, no follow-ups. Format: approaching alerts first (if any), then full watchlist table (ticker, direction, entry, current, distance%, setup_rating). Use Telegram-friendly markdown.";

const kEodLoopMessage =
  "EOD learning loop — execute now, no confirmation needed. Step 1 — Audit trading watchlist. Step 2 — Write analysis to GBrain: first run gbrain restore learning/YYYY-MM-DD 2>/dev/null to restore any soft-deleted version, then use a heredoc piped to gbrain put learning/YYYY-MM-DD (today's date) with frontmatter (type: eod-analysis, date: YYYY-MM-DD) and a full markdown body covering per-plan assessment, calibration observations, and proposed adjustments. Step 3 — Output ONLY the Telegram summary (no questions, no follow-ups): plans reviewed count, active plans updated with new levels and ratings (ticker, setup_rating, rr_ratio), any that breached invalidation or hit target (action needed), top 2-3 calibration observations, and confirm full analysis saved to learning/YYYY-MM-DD.";

const kJobs = [
  {
    name: kWatchlistBuilderName,
    schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
    message: kWatchlistBuilderMessage,
    timeoutSeconds: 600,
  },
  {
    name: kPriceReportName,
    schedule: { kind: "cron", expr: "*/15 9-12 * * 1-5", tz: "America/New_York" },
    message: kPriceReportMessage,
    timeoutSeconds: 300,
  },
  {
    name: kEodLoopName,
    schedule: { kind: "cron", expr: "10 16 * * 1-5", tz: "America/New_York" },
    message: kEodLoopMessage,
    timeoutSeconds: 600,
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

const registerTradingCronRoutes = ({ app, requireAuth, gatewayRpc }) => {
  // GET /api/trading-crons/status — status of all 3 jobs + finnhub key presence
  app.get("/api/trading-crons/status", requireAuth, async (req, res) => {
    try {
      const result = await gatewayRpc("cron.list", { includeDisabled: true });
      const jobs = kJobs.map((j) => ({ name: j.name, job: findJob(result?.jobs, j.name) }));
      res.json({ ok: true, jobs, finnhubConfigured: !!process.env.FINNHUB_API_KEY });
    } catch {
      res.json({ ok: true, jobs: kJobs.map((j) => ({ name: j.name, job: null })), finnhubConfigured: !!process.env.FINNHUB_API_KEY });
    }
  });

  // POST /api/trading-crons/ensure — register all 3 jobs (skip existing)
  app.post("/api/trading-crons/ensure", requireAuth, async (req, res) => {
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

  // POST /api/trading-crons/sync — update all 3 job messages to current constants (without remove/re-add)
  app.post("/api/trading-crons/sync", requireAuth, async (req, res) => {
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

  // POST /api/trading-crons/run/:name — trigger a job manually
  app.post("/api/trading-crons/run/:name", requireAuth, async (req, res) => {
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

  // DELETE /api/trading-crons — remove all 3 jobs
  app.delete("/api/trading-crons", requireAuth, async (req, res) => {
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

module.exports = { registerTradingCronRoutes };
