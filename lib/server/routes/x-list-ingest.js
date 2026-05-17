const buildIngestMessage = (listId) =>
  `Fetch the 10 most recent posts from X list ID ${listId} using the xurl skill.

For each post:
- Use note_tweet text if present (X articles), otherwise use the regular tweet text. Never concatenate both.
- Include any quoted or referenced posts inline under a ## Quoted section, with the author handle and URL resolved from the API response.
- Ingest each post into gbrain using slug exactly twitter/post/<tweet_id> — no variations, no date suffixes. Skip if already exists. On check error, skip and count as error — never ingest under a different slug.
- Each page frontmatter: type=tweet, tweet_id, author (with @), list_id=${listId}, posted_at (ISO-8601), url=https://twitter.com/<handle>/status/<tweet_id>, tags=[twitter, x-list-ingest], quoted_ids if any.

After processing all posts, your reply MUST end with exactly this line:
RESULT: ingested=<n>, skipped_existing=<n>, errors=<n>, slugs=<comma-separated list>`;

const findCronJob = (jobs) =>
  Array.isArray(jobs) ? (jobs.find((j) => j.name === "x-list-ingest") ?? null) : null;

const buildCronAddParams = (listId) => ({
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
  delivery: { mode: "none" },
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
    try {
      const listResult = await gatewayRpc("cron.list", { includeDisabled: true });
      const existing = findCronJob(listResult?.jobs);
      if (existing) {
        return res.json({ ok: true, skipped: true, job: existing });
      }

      const added = await gatewayRpc("cron.add", buildCronAddParams(listId), { timeoutMs: 30000 });
      const jobId = String(added?.id || "");
      if (!jobId) {
        return res.status(500).json({ ok: false, error: "Could not parse job ID from cron.add response" });
      }

      await gatewayRpc("cron.update", {
        id: jobId,
        patch: { failureAlert: true },
      }).catch(() => {});
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
