const buildIngestMessage = (listId) =>
  `Fetch the 10 most recent posts from X list ID ${listId}.
Run: xurl "/2/lists/${listId}/tweets?tweet.fields=note_tweet,article&max_results=10"
(xurl is a standalone CLI binary — run it directly, not via openclaw. Do not omit tweet.fields or the long-form body will be missing.)

For each post:
- Primary body (in priority order): article.plain_text if present (X Article), else note_tweet.text if present (long-form tweet), else the tweet text field. Never concatenate multiple fields.
- Include any quoted or referenced posts inline under a ## Quoted section, with the author handle and URL resolved from the API response.
- Ingest each post into gbrain using slug exactly twitter/post/<tweet_id> — no variations, no date suffixes. Skip if already exists. On check error, skip and count as error — never ingest under a different slug.
- Each page frontmatter: type=tweet, tweet_id, author (with @), list_id=${listId}, posted_at (ISO-8601), url=https://twitter.com/<handle>/status/<tweet_id>, tags=[twitter, x-list-ingest], quoted_ids if any.

After processing all posts, end your reply with a result block in this exact inline format — no tables, no slugs:

X List Ingest — <n> new · <n> skipped · <n> error(s)
For each ingested post (one line each): ✅ @handle — "<text preview, max 80 chars, truncate with …>"
For each error (one line each): ❌ @handle — <reason>
If skipped count > 0 (one line): ⏭ <n> already in brain

Example:
X List Ingest — 2 new · 7 skipped · 1 error(s)
✅ @alice — "Just shipped something big that changes everything about how we…"
✅ @bob — "Thread on why the old approach was fundamentally broken 🧵"
❌ @carol — check error
⏭ 7 already in brain`;

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
