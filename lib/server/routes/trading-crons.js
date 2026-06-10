const kWatchlistBuilderName = "trading-watchlist-builder";
const kPriceReportName = "trading-price-report";
const kEodLoopName = "trading-eod-loop";

const kWatchlistBuilderMessage =
  "Watchlist builder — execute now, no confirmation needed. Use the gbrain shell command throughout. Step 0 — Check last run time: Run: gbrain get watchlist/last-run 2>/dev/null to read the last_run: field from its YAML frontmatter. If the page does not exist or has no last_run field, run: date -u +%Y-%m-%dT00:00:00Z to get today's midnight UTC and use that as the cutoff. Remember this timestamp as LAST_RUN_TIME. Step 1 — Load tweet signal candidates: Extract just the date portion of LAST_RUN_TIME (YYYY-MM-DD). Run: gbrain list --type tweet --tag x-list-ingest --updated-after <LAST_RUN_TIME_DATE> --limit 100 to get tweet slugs. For each slug, run: gbrain get <slug> to read its frontmatter and body. Step 2 — Find tweet signals since last run: Collect pages with type: tweet and tags including x-list-ingest whose posted_at: or date: frontmatter field (ISO timestamp) is strictly after LAST_RUN_TIME. Skip any tweet whose posted_at: (or date: if posted_at: is absent) is at or before LAST_RUN_TIME — it was already processed in a previous run. For each qualifying tweet, extract only: ticker ($ symbol → use lowercase for slugs) and direction (bullish language = LONG, bearish = SHORT). Entry, target, invalidation, and conviction points will be determined by your own analysis in Step 6 — do not extract them from the tweet. Step 3 — Load existing plans and prices: Run: gbrain list --type trading-plan --limit 500 to get all plan slugs. For each slug returned, run: gbrain get <slug> to read its frontmatter. Read prices from /data/.openclaw/finnhub-prices.json if it exists. Step 4 — Conviction audit (do NOT update GBrain): For each existing plan with status: active, check: (a) does any tweet signal contradict the plan direction? (b) has the current price crossed the invalidation level? If so, note as a conviction concern for the Telegram report only — do not modify the plan. Step 5 — Apply policy gates to new plan candidates: PLAN_CAP — reject all new plans if 10 or more active plans already exist. ALREADY_EXISTS — skip if any plan (any status) already exists for that ticker. CONFLICT — if an active plan exists with the opposite direction, report conflict and do not create. Step 6 — Build and save trading plans: For each ticker/direction pair that passed all gates in Step 5, build a complete trading plan using your own analysis, with the explicit goal of achieving a Reward:Risk ratio greater than 2:1. Choose entry price (optimal risk entry near a key support or resistance level), target price (a meaningful level to take profit), and invalidation price (the level that definitively negates the thesis) such that abs(target - entry) / abs(entry - invalidation) > 2.0. If no valid level combination yields R:R > 2.0 for this ticker, skip it (record as RR_TOO_LOW rejection). Compute rr_ratio = abs(target - entry) / abs(entry - invalidation) once levels are set. Then rate the setup 1-5 where: 5 = excellent (RR > 3.0, entry at a key technical level, strong momentum alignment), 4 = good (RR 2.5–3.0, clear levels, solid conviction), 3 = acceptable (RR 2.0–2.5, levels clear enough), 2 = marginal (barely > 2.0 or setup quality questionable), 1 = poor (skip — do not create the plan, record as SETUP_TOO_WEAK rejection). Write 3 conviction points — specific, non-generic reasons the setup is valid (e.g. named technical level, catalyst from the tweet, price structure, sector/market context). Then: first run: gbrain restore plans/<lowercase-ticker> 2>/dev/null to restore any soft-deleted version, then write using gbrain put plans/<lowercase-ticker> with YAML frontmatter: type: trading-plan, ticker: TICKER, direction: LONG or SHORT, entry: NUMBER, target: NUMBER, invalidation: NUMBER, rr_ratio: NUMBER, setup_rating: NUMBER, conviction: 3, status: pending-confirmation. Write the body as a full structured trading plan:\n## Trading Plan — TICKER DIRECTION\n\n**Entry:** $ENTRY | **Target:** $TARGET | **Invalidation:** $INVALIDATION | **R/R:** RR_RATIO\n\n### Conviction\n1. [first conviction point]\n2. [second conviction point]\n3. [third conviction point] Step 7 — Update state: Write watchlist/current to GBrain listing all active and pending-confirmation tickers. Write the ticker list as a JSON array to /data/.openclaw/finnhub-watchlist.json using shell redirection. Step 8 — Output ONLY the Telegram report (no questions, no follow-ups): new pending plans (ticker, direction, entry, target, rr_ratio, setup_rating), rejections (ticker + reason), conviction alerts (ticker + concern), watchlist count, and how many tweets were skipped as already-processed. Step 9 — Record this run: Run: gbrain restore watchlist/last-run 2>/dev/null || true then write watchlist/last-run with YAML frontmatter type: watchlist-state, last_run: <current UTC ISO timestamp e.g. 2026-06-05T11:30:00Z> and body 'Watchlist builder run timestamp.'";

const kPriceReportMessage =
  "Price report — execute now, no confirmation needed.\n\nStep 0 — Check market status: Run: curl -s 'https://finnhub.io/api/v1/stock/market-status?exchange=US&token=$FINNHUB_API_KEY' — parse the JSON. If isOpen is false, output 'Market closed — skipping price report' and stop immediately.\n\nStep 1 — Fetch all plan data and prices in one shell command. Run exactly:\nfor slug in $(gbrain list --type trading-plan --limit 500 2>/dev/null); do echo \"=== $slug ===\"; gbrain get \"$slug\" 2>/dev/null; done; echo \"=== PRICES ===\"; cat /data/.openclaw/finnhub-prices.json 2>/dev/null || echo \"no prices file\"\n\nStep 2 — From the output above: collect every plan where the frontmatter field status is exactly \"active\". For each active plan read: ticker, direction, entry, target, invalidation, rr_ratio, setup_rating. Then look up current_price for that ticker in the PRICES JSON. Compute distance = abs(current_price - entry) / entry * 100. If the ticker is not in the prices JSON, show distance as \"n/a\".\n\nStep 3 — Plans where distance <= 2% get an APPROACHING alert.\n\nStep 4 — Output ONLY the formatted Telegram report — no questions, no follow-ups. Format: approaching alerts first (if any), then full watchlist table (ticker, direction, entry, current, distance%, setup_rating). Use Telegram-friendly markdown.";

const kEodLoopMessage =
  "EOD learning loop — execute now, no confirmation needed. Use the gbrain shell command throughout. Step 1 — Load all plans: Run: gbrain list --type trading-plan --limit 500 to get all plan slugs. For each slug returned, run: gbrain get <slug> to read it. Process all plans (active, closed, or invalidated). Step 2 — Fetch fresh closing prices from Finnhub: Collect the unique set of tickers from all plans loaded in Step 1. For each ticker, run: curl -s 'https://finnhub.io/api/v1/quote?symbol=TICKER&token=$FINNHUB_API_KEY' — fields: c=current price, o=open, dp=change%, t=unix timestamp. Build a JSON object mapping each ticker to {open, current, changePct, updatedAt} and write it to /data/.openclaw/finnhub-prices.json using a heredoc or python3 -c. If FINNHUB_API_KEY is unset or a quote returns c=0, note that ticker as missing data. Step 3 — Analyze each plan against today's price action: Did the current price breach the invalidation level? (plan may need to be closed) Did the current price reach the target? (plan may need to be closed as winner) How far is current price from entry? (conviction calibration signal) Does the conviction rating (1-5) match the price behavior? Step 4 — Update active trading plans with calibrated levels and setup rating: For each plan with status: active from Step 1, use today's closing price from Step 2 to re-evaluate entry, target, and invalidation. Compute rr_ratio = abs(target - entry) / abs(entry - invalidation). If the existing levels already yield rr_ratio > 2.0 and the plan is still valid (price has not crossed invalidation or hit target), you may keep them or tighten further. If rr_ratio <= 2.0 or levels are stale, adjust: for LONG set entry near the nearest support level, for SHORT near the nearest resistance level; set target at the next meaningful level in the trade direction; set invalidation at the level that definitively negates the thesis. Recompute rr_ratio after any adjustment. Then rate the setup 1-5 where: 5 = excellent (RR > 3.0, entry at a key technical level, strong momentum alignment), 4 = good (RR 2.5–3.0, clear levels, solid conviction), 3 = acceptable (RR 2.0–2.5, levels clear enough), 2 = marginal (barely > 2.0 or setup quality questionable), 1 = poor (flag for manual review). For each active plan write back to GBrain: first run: gbrain restore plans/<lowercase-ticker> 2>/dev/null || true, then run: gbrain put plans/<lowercase-ticker> with YAML frontmatter preserving all existing fields and adding or updating: entry: NUMBER, target: NUMBER, invalidation: NUMBER, rr_ratio: NUMBER (rounded to 2 decimal places), setup_rating: NUMBER (1–5). Preserve the existing plan body exactly — do not replace it. Step 5 — Write analysis to GBrain: first run gbrain restore learning/YYYY-MM-DD 2>/dev/null to restore any soft-deleted version, then use a heredoc piped to gbrain put learning/YYYY-MM-DD (today's date) with frontmatter (type: eod-analysis, date: YYYY-MM-DD) and a full markdown body covering per-plan assessment, calibration observations, and proposed adjustments. Step 6 — Output ONLY the Telegram summary (no questions, no follow-ups): plans reviewed count, active plans updated with new levels and ratings (ticker, setup_rating, rr_ratio), any that breached invalidation or hit target (action needed), top 2-3 calibration observations, and confirm full analysis saved to learning/YYYY-MM-DD.";

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
