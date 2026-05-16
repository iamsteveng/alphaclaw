const { spawnSync } = require("child_process");

const runOpenclaw = (args, timeout = 15000) =>
  spawnSync("openclaw", args, { encoding: "utf8", timeout, env: process.env });

const buildIngestMessage = (listId) =>
  `Fetch the 10 most recent posts from X list ID ${listId} using the xurl skill.

For each post:
- Use note_tweet text if present (X articles), otherwise use the regular tweet text. Never concatenate both.
- Include any quoted or referenced posts inline under a '## Quoted' section, with the author handle and URL resolved from the API response.
- Ingest each post into gbrain using slug exactly 'twitter/post/<tweet_id>' — no variations, no date suffixes. Skip if already exists. On check error, skip and count as error — never ingest under a different slug.
- Each page frontmatter: type=tweet, tweet_id, author (with @), list_id=${listId}, posted_at (ISO-8601), url=https://twitter.com/<handle>/status/<tweet_id>, tags=[twitter, x-list-ingest], quoted_ids if any.

After processing all posts, your reply MUST end with exactly this line:
RESULT: ingested=<n>, skipped_existing=<n>, errors=<n>, slugs=<comma-separated list>`;

const findCronJob = () => {
  const result = runOpenclaw(["cron", "list", "--json"]);
  if (result.error || result.status !== 0) return null;
  try {
    const jobs = JSON.parse(result.stdout || "[]");
    return Array.isArray(jobs) ? (jobs.find((j) => j.name === "x-list-ingest") ?? null) : null;
  } catch {
    return null;
  }
};

const registerXListIngestRoutes = ({ app, requireAuth }) => {
  app.get("/api/x-list-ingest/status", requireAuth, (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || null;
    const job = findCronJob();
    res.json({ ok: true, envVarSet: !!listId, listId, job });
  });

  app.post("/api/x-list-ingest/ensure", requireAuth, (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || "";
    if (!listId) {
      return res.status(400).json({ ok: false, error: "X_INGEST_LIST_ID is not set" });
    }
    const existing = findCronJob();
    if (existing) {
      return res.json({ ok: true, skipped: true, job: existing });
    }
    const addResult = runOpenclaw(
      [
        "cron", "add",
        "--name", "x-list-ingest",
        "--agent", "main",
        "--cron", "0 * * * *",
        "--session", "isolated",
        "--disabled",
        "--message", buildIngestMessage(listId),
        "--announce",
        "--timeout-seconds", "300",
        "--thinking", "low",
        "--tz", "UTC",
        "--json",
      ],
      30000,
    );
    if (addResult.error || addResult.status !== 0) {
      return res
        .status(500)
        .json({ ok: false, error: String(addResult.stderr || "cron add failed") });
    }
    let jobId = "";
    try {
      jobId = String(JSON.parse(addResult.stdout || "{}").id || "");
    } catch {}
    if (!jobId) {
      return res.status(500).json({ ok: false, error: "Could not parse job ID" });
    }
    runOpenclaw(
      ["cron", "edit", jobId, "--failure-alert", "--failure-alert-channel", "last", "--failure-alert-after", "1", "--failure-alert-mode", "announce"],
      10000,
    );
    runOpenclaw(["cron", "edit", jobId, "--enable"], 10000);
    const job = findCronJob();
    res.json({ ok: true, registered: true, jobId, job });
  });

  app.delete("/api/x-list-ingest", requireAuth, (req, res) => {
    const existing = findCronJob();
    if (!existing) {
      return res.json({ ok: true, skipped: true, reason: "not registered" });
    }
    const rmResult = runOpenclaw(["cron", "rm", String(existing.id || "")], 15000);
    if (rmResult.error || rmResult.status !== 0) {
      return res
        .status(500)
        .json({ ok: false, error: String(rmResult.stderr || "cron rm failed") });
    }
    res.json({ ok: true, removed: true });
  });
};

module.exports = { registerXListIngestRoutes };
