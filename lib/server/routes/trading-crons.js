const kWatchlistBuilderName = "trading-watchlist-builder";
const kPriceReportName = "trading-price-report";
const kEodLoopName = "trading-eod-loop";

const kWatchlistBuilderMessage =
  "Watchlist builder — execute now, no confirmation needed. Use the gbrain shell command throughout. Step 1 — Load all GBrain content: Run gbrain list. For every slug returned, run gbrain get <slug> to read its frontmatter and body. Step 2 — Find tweet signals: Collect pages with type: tweet and tags including x-list-ingest. For each tweet, extract: ticker ($ symbol → use lowercase for slugs), direction (bullish language = LONG, bearish = SHORT), entry price, target price, invalidation price (infer from support levels, resistance, MAs if not explicit). Compute rr_ratio = abs(target - entry) / abs(entry - invalidation). Step 3 — Load existing plans and prices: Collect all pages with slug starting with plans/ (type: trading-plan). Read prices from /data/.openclaw/finnhub-prices.json if it exists. Step 4 — Conviction audit (do NOT update GBrain): For each existing plan with status: active, check: (a) does any tweet signal contradict the plan direction? (b) has the current price crossed the invalidation level? If so, note as a conviction concern for the Telegram report only — do not modify the plan. Step 5 — Apply policy gates to new plan candidates: PLAN_CAP — reject all new plans if 10 or more active plans already exist. ALREADY_EXISTS — skip if any plan (any status) already exists for that ticker. CONFLICT — if an active plan exists with the opposite direction, report conflict and do not create. RR_TOO_LOW — reject if rr_ratio < 2.0. Step 6 — Create approved plans: For each new plan passing all gates, first run: gbrain restore plans/<lowercase-ticker> 2>/dev/null to restore any soft-deleted version, then write using gbrain put plans/<lowercase-ticker> with YAML frontmatter: type: trading-plan, ticker: TICKER, direction: LONG or SHORT, entry: NUMBER, target: NUMBER, invalidation: NUMBER, rr_ratio: NUMBER, conviction: 3, status: pending-confirmation. Include a one-line body. Step 7 — Update state: Write watchlist/current to GBrain listing all active and pending-confirmation tickers. Write the ticker list as a JSON array to /data/.openclaw/finnhub-watchlist.json using shell redirection. Step 8 — Output ONLY the Telegram report (no questions, no follow-ups): new pending plans (ticker, direction, entry, target, rr_ratio), rejections (ticker + reason), conviction alerts (ticker + concern), watchlist count.";

const kPriceReportMessage =
  "Price report — execute now, no confirmation needed. Steps: 1) Run: gbrain list — to see all pages. 2) For each slug starting with plans/, run: gbrain get <slug> — read frontmatter (ticker, direction, entry, target, invalidation, rr_ratio, conviction, status). Skip any page where status is not active. 3) Read /data/.openclaw/finnhub-prices.json for current prices. 4) For each active plan compute: distance = abs(current_price - entry) / entry * 100. Plans within 2% of entry get an APPROACHING alert. 5) Output ONLY the formatted report — no questions, no follow-ups. Format: start with approaching alerts (if any), then full watchlist table (ticker, direction, entry, current, distance%, conviction). Use Telegram-friendly markdown.";

const kEodLoopMessage =
  "EOD learning loop — execute now, no confirmation needed. Use the gbrain shell command throughout. Step 1 — Load all plans: Run: gbrain list to see all pages. For each slug starting with plans/, run: gbrain get <slug> to read it. Process all plans (active, closed, or invalidated). Step 2 — Load current prices: Read /data/.openclaw/finnhub-prices.json for today's prices. For any ticker not in the prices file, note it as missing data. Step 3 — Analyze each plan against today's price action: Did the current price breach the invalidation level? (plan may need to be closed) Did the current price reach the target? (plan may need to be closed as winner) How far is current price from entry? (conviction calibration signal) Does the conviction rating (1-5) match the price behavior? Step 4 — Write analysis to GBrain: first run gbrain restore learning/YYYY-MM-DD 2>/dev/null to restore any soft-deleted version, then use a heredoc piped to gbrain put learning/YYYY-MM-DD (today's date) with frontmatter (type: eod-analysis, date: YYYY-MM-DD) and a full markdown body covering per-plan assessment, calibration observations, and proposed adjustments. Step 5 — Output ONLY the Telegram summary (no questions, no follow-ups): plans reviewed count, any that breached invalidation or hit target (action needed), top 2-3 calibration observations, and confirm full analysis saved to learning/YYYY-MM-DD.";

const kJobs = [
  {
    name: kWatchlistBuilderName,
    schedule: { kind: "cron", expr: "30 11 * * 1-5", tz: "UTC" },
    message: kWatchlistBuilderMessage,
    timeoutSeconds: 600,
  },
  {
    name: kPriceReportName,
    schedule: { kind: "cron", expr: "*/15 13-15 * * 1-5", tz: "UTC" },
    message: kPriceReportMessage,
    timeoutSeconds: 120,
  },
  {
    name: kEodLoopName,
    schedule: { kind: "cron", expr: "10 8 * * 1-5", tz: "UTC" },
    message: kEodLoopMessage,
    timeoutSeconds: 300,
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
  // GET /api/trading-crons/status — status of all 3 jobs
  app.get("/api/trading-crons/status", requireAuth, async (req, res) => {
    try {
      const result = await gatewayRpc("cron.list", { includeDisabled: true });
      const jobs = kJobs.map((j) => ({ name: j.name, job: findJob(result?.jobs, j.name) }));
      res.json({ ok: true, jobs });
    } catch {
      res.json({ ok: true, jobs: kJobs.map((j) => ({ name: j.name, job: null })) });
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
