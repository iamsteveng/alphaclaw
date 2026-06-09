const kJobName = "market-risk-score";
const kMessage =
  "Market risk score — execute now, no confirmation needed. Step 1 — Run the scoring script: python3 /data/.openclaw/workspace/skills/market-risk-score/market_risk_score.py --json 2>/dev/null. Capture all stdout as JSON. If the script errors or produces no output, output \"Error: market risk score script failed\" and stop. Step 2 — Parse the JSON: read fields classification (string e.g. \"Risk Off\"), bearish_count (integer 0–4), and signals.DXY, signals.HYG, signals.SPY, signals.VIX (true=bearish, false=bullish, null=data unavailable). Step 3 — Write to GBrain: first run: gbrain restore market/risk-$(date +%Y-%m-%d) 2>/dev/null || true — then pipe a heredoc to: gbrain put market/risk-$(date +%Y-%m-%d) with YAML frontmatter: type: market-risk, date: YYYY-MM-DD (today), classification: <value>, bearish_count: <N>, dxy_bearish: <true/false/null>, hyg_bearish: <true/false/null>, spy_bearish: <true/false/null>, vix_bearish: <true/false/null> — and a one-line body: \"<classification> — <bearish_count>/4 bearish factors\". Step 4 — Output ONLY: classification, bearish_count/4 bearish, one line per factor (DXY/HYG/SPY/VIX: bearish/bullish/unavailable), one-sentence market condition summary. No questions, no follow-ups.";
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
