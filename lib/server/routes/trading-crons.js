const kWatchlistBuilderName = "trading-watchlist-builder";
const kPriceReportName = "trading-price-report";
const kEodLoopName = "trading-eod-loop";
const kMarketRiskScoreName = "trading-market-risk-score";

const kWatchlistBuilderMessage =
  "Watchlist builder — execute now, no confirmation needed. Use the gbrain shell command throughout. Step 0 — Check last run time: Run: gbrain get watchlist/last-run 2>/dev/null to read the last_run: field from its YAML frontmatter. If the page does not exist or has no last_run field, run: date -u +%Y-%m-%dT00:00:00Z to get today's midnight UTC and use that as the cutoff. Remember this timestamp as LAST_RUN_TIME. Step 1 — Load tweet signal candidates: Extract just the date portion of LAST_RUN_TIME (YYYY-MM-DD). Run: gbrain list --type tweet --tag x-list-ingest --updated-after <LAST_RUN_TIME_DATE> --limit 500 | tail -20 | awk '{print $1}' to get the 20 most recently updated tweet slugs (gbrain list returns ascending order, tail -20 selects the most recent). For each slug, run: gbrain get <slug> to read its frontmatter and body. Step 2 — Find tweet signals since last run: Collect pages with type: tweet and tags including x-list-ingest whose posted_at: or date: frontmatter field (ISO timestamp) is strictly after LAST_RUN_TIME. Skip any tweet whose posted_at: (or date: if posted_at: is absent) is at or before LAST_RUN_TIME — it was already processed in a previous run. For each qualifying tweet, extract: ticker ($ symbol → use lowercase for slugs), direction (bullish language = LONG, bearish = SHORT), entry price, target price, invalidation price (infer from support levels, resistance, MAs if not explicit). Compute rr_ratio = abs(target - entry) / abs(entry - invalidation). Step 3 — Load existing plans and prices: Run: gbrain list --type trading-plan --limit 500 to get all plan slugs. For each slug returned, run: gbrain get <slug> to read its frontmatter. Read prices from /data/.openclaw/finnhub-prices.json if it exists. Step 4 — Conviction audit (do NOT update GBrain): For each existing plan with status: active, check: (a) does any tweet signal contradict the plan direction? (b) has the current price crossed the invalidation level? If so, note as a conviction concern for the Telegram report only — do not modify the plan. Step 5 — Apply policy gates to new plan candidates: PLAN_CAP — reject all new plans if 10 or more active plans already exist. ALREADY_EXISTS — skip if any plan (any status) already exists for that ticker. CONFLICT — if an active plan exists with the opposite direction, report conflict and do not create. RR_TOO_LOW — reject if rr_ratio < 2.0. Step 6 — Create approved plans: For each new plan passing all gates, first run: gbrain restore plans/<lowercase-ticker> 2>/dev/null to restore any soft-deleted version, then write using gbrain put plans/<lowercase-ticker> with YAML frontmatter: type: trading-plan, ticker: TICKER, direction: LONG or SHORT, entry: NUMBER, target: NUMBER, invalidation: NUMBER, rr_ratio: NUMBER, conviction: 3, status: pending-confirmation. Include a one-line body. Step 7 — Update state: Write watchlist/current to GBrain listing all active and pending-confirmation tickers. Write the ticker list as a JSON array to /data/.openclaw/finnhub-watchlist.json using shell redirection. Step 8 — Output ONLY the Telegram report (no questions, no follow-ups): new pending plans (ticker, direction, entry, target, rr_ratio), rejections (ticker + reason), conviction alerts (ticker + concern), watchlist count, and how many tweets were skipped as already-processed. Step 9 — Record this run: Run: gbrain restore watchlist/last-run 2>/dev/null || true then write watchlist/last-run with YAML frontmatter type: watchlist-state, last_run: <current UTC ISO timestamp e.g. 2026-06-05T11:30:00Z> and body 'Watchlist builder run timestamp.'";

const kPriceReportMessage =
  "Price report — execute now, no confirmation needed. Step 0 — Check market status: Run: curl -s 'https://finnhub.io/api/v1/stock/market-status?exchange=US&token=$FINNHUB_API_KEY' — parse the JSON response. If isOpen is false, output 'Market closed — skipping price report' and stop immediately without running any further steps. Steps: 1) Run: gbrain list --type trading-plan --limit 500 — to get all plan slugs. 2) For each slug returned, run: gbrain get <slug> — read frontmatter (ticker, direction, entry, target, invalidation, rr_ratio, conviction, status). Skip any page where status is not active. 3) Read /data/.openclaw/finnhub-prices.json for current prices. 4) For each active plan compute: distance = abs(current_price - entry) / entry * 100. Plans within 2% of entry get an APPROACHING alert. 5) Output ONLY the formatted report — no questions, no follow-ups. Format: start with approaching alerts (if any), then full watchlist table (ticker, direction, entry, current, distance%, conviction). Use Telegram-friendly markdown.";

const kEodLoopMessage =
  "EOD learning loop — execute now, no confirmation needed. Use the gbrain shell command throughout. Step 1 — Load all plans: Run: gbrain list --type trading-plan --limit 500 to get all plan slugs. For each slug returned, run: gbrain get <slug> to read it. Process all plans (active, closed, or invalidated). Step 2 — Fetch fresh closing prices from Finnhub: Collect the unique set of tickers from all plans loaded in Step 1. For each ticker, run: curl -s 'https://finnhub.io/api/v1/quote?symbol=TICKER&token=$FINNHUB_API_KEY' — fields: c=current price, o=open, dp=change%, t=unix timestamp. Build a JSON object mapping each ticker to {open, current, changePct, updatedAt} and write it to /data/.openclaw/finnhub-prices.json using a heredoc or python3 -c. If FINNHUB_API_KEY is unset or a quote returns c=0, note that ticker as missing data. Step 3 — Analyze each plan against today's price action: Did the current price breach the invalidation level? (plan may need to be closed) Did the current price reach the target? (plan may need to be closed as winner) How far is current price from entry? (conviction calibration signal) Does the conviction rating (1-5) match the price behavior? Step 4 — Write analysis to GBrain: first run gbrain restore learning/YYYY-MM-DD 2>/dev/null to restore any soft-deleted version, then use a heredoc piped to gbrain put learning/YYYY-MM-DD (today's date) with frontmatter (type: eod-analysis, date: YYYY-MM-DD) and a full markdown body covering per-plan assessment, calibration observations, and proposed adjustments. Step 5 — Output ONLY the Telegram summary (no questions, no follow-ups): plans reviewed count, any that breached invalidation or hit target (action needed), top 2-3 calibration observations, and confirm full analysis saved to learning/YYYY-MM-DD.";

const kMarketRiskScoreMessage =
  "Market risk score — execute now, no confirmation needed. Step 1 — Fetch market data using curl (parse each JSON response): SPY quote: curl -s 'https://finnhub.io/api/v1/quote?symbol=SPY&token=$FINNHUB_API_KEY' — fields: c=current, o=open, dp=change%. QQQ quote: curl -s 'https://finnhub.io/api/v1/quote?symbol=QQQ&token=$FINNHUB_API_KEY'. VIXY quote (VIX proxy ETF): curl -s 'https://finnhub.io/api/v1/quote?symbol=VIXY&token=$FINNHUB_API_KEY'. Step 2 — Compute risk score (integer 1=low risk, 5=high risk): Start at 3 (neutral). Apply adjustments: VIXY price > 25 → +1, VIXY price > 35 → +2 total; VIXY price < 15 → -1. SPY dp < -1% → +1, SPY dp < -2% → +2 total; SPY dp > +1% → -1. QQQ dp < -1.5% → +1. Clamp final score to 1–5. Step 3 — Write to GBrain: Run: gbrain restore market/risk-$(date +%Y-%m-%d) 2>/dev/null || true — then pipe to gbrain put market/risk-$(date +%Y-%m-%d) with YAML frontmatter: type: market-risk, date: YYYY-MM-DD, score: N, spy_change_pct: N, qqq_change_pct: N, vixy_price: N — and a one-line body summarising conditions. Step 4 — Output ONLY: risk score (1–5), SPY change%, QQQ change%, VIXY price, one-sentence market condition. No questions, no follow-ups.";

const kJobs = [
  {
    name: kWatchlistBuilderName,
    schedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "America/New_York" },
    message: kWatchlistBuilderMessage,
    timeoutSeconds: 600,
  },
  {
    name: kMarketRiskScoreName,
    schedule: { kind: "cron", expr: "35 9 * * 1-5", tz: "America/New_York" },
    message: kMarketRiskScoreMessage,
    timeoutSeconds: 120,
  },
  {
    name: kPriceReportName,
    schedule: { kind: "cron", expr: "*/15 9-12 * * 1-5", tz: "America/New_York" },
    message: kPriceReportMessage,
    timeoutSeconds: 120,
  },
  {
    name: kEodLoopName,
    schedule: { kind: "cron", expr: "30 16 * * 1-5", tz: "America/New_York" },
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
