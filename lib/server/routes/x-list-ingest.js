const shellEscape = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const buildIngestMessage = (listId) =>
  `Fetch the 10 most recent posts from X list ID ${listId} using the xurl skill.

For each post:
- Use note_tweet text if present (X articles), otherwise use the regular tweet text. Never concatenate both.
- Include any quoted or referenced posts inline under a ## Quoted section, with the author handle and URL resolved from the API response.
- Ingest each post into gbrain using slug exactly twitter/post/<tweet_id> — no variations, no date suffixes. Skip if already exists. On check error, skip and count as error — never ingest under a different slug.
- Each page frontmatter: type=tweet, tweet_id, author (with @), list_id=${listId}, posted_at (ISO-8601), url=https://twitter.com/<handle>/status/<tweet_id>, tags=[twitter, x-list-ingest], quoted_ids if any.

After processing all posts, your reply MUST end with exactly this line:
RESULT: ingested=<n>, skipped_existing=<n>, errors=<n>, slugs=<comma-separated list>`;

const parseJson = (raw) => {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return null;
  }
};

// cron list --json returns { jobs: [...], total, ... } not a bare array
const parseJobsFromCronList = (raw) => {
  const parsed = parseJson(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs;
  return [];
};

const findCronJob = (jobs) =>
  Array.isArray(jobs) ? (jobs.find((j) => j.name === "x-list-ingest") ?? null) : null;

// Pass the server's admin gateway token so the CLI bypasses device-scope upgrade
const getTokenFlag = () => {
  const token = String(process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
  return token ? `--token ${shellEscape(token)}` : "";
};

const buildCmd = (...parts) => parts.filter(Boolean).join(" ");

const registerXListIngestRoutes = ({ app, requireAuth, clawCmd }) => {
  app.get("/api/x-list-ingest/status", requireAuth, async (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || null;
    try {
      const result = await clawCmd(buildCmd("cron list", getTokenFlag(), "--json"), { quiet: true });
      const jobs = parseJobsFromCronList(result?.stdout);
      res.json({ ok: true, envVarSet: !!listId, listId, job: findCronJob(jobs) });
    } catch {
      res.json({ ok: true, envVarSet: !!listId, listId, job: null });
    }
  });

  app.post("/api/x-list-ingest/ensure", requireAuth, async (req, res) => {
    const listId = process.env.X_INGEST_LIST_ID || "";
    if (!listId) {
      return res.status(400).json({ ok: false, error: "X_INGEST_LIST_ID is not set" });
    }
    const tokenFlag = getTokenFlag();
    try {
      const listResult = await clawCmd(buildCmd("cron list", tokenFlag, "--json"), { quiet: true });
      const jobs = parseJobsFromCronList(listResult?.stdout);
      const existing = findCronJob(jobs);
      if (existing) {
        return res.json({ ok: true, skipped: true, job: existing });
      }

      const message = buildIngestMessage(listId);
      const addCmd = buildCmd(
        "cron add",
        tokenFlag,
        "--name x-list-ingest",
        "--agent main",
        "--cron", shellEscape("0 * * * *"),
        "--session isolated",
        "--disabled",
        "--message", shellEscape(message),
        "--announce",
        "--timeout-seconds 300",
        "--thinking low",
        "--tz UTC",
        "--json",
      );

      const addResult = await clawCmd(addCmd, { quiet: true, timeoutMs: 30000 });
      if (!addResult?.ok) {
        return res.status(500).json({ ok: false, error: String(addResult?.stderr || "cron add failed") });
      }
      const parsed = parseJson(addResult?.stdout);
      const jobId = String(parsed?.id || "");
      if (!jobId) {
        return res.status(500).json({ ok: false, error: "Could not parse job ID" });
      }

      await clawCmd(
        buildCmd("cron edit", tokenFlag, shellEscape(jobId), "--failure-alert --failure-alert-channel last --failure-alert-after 1 --failure-alert-mode announce"),
        { quiet: true },
      ).catch(() => {});
      await clawCmd(buildCmd("cron edit", tokenFlag, shellEscape(jobId), "--enable"), { quiet: true }).catch(() => {});

      const listResult2 = await clawCmd(buildCmd("cron list", tokenFlag, "--json"), { quiet: true });
      const jobs2 = parseJobsFromCronList(listResult2?.stdout);
      res.json({ ok: true, registered: true, jobId, job: findCronJob(jobs2) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });

  app.delete("/api/x-list-ingest", requireAuth, async (req, res) => {
    const tokenFlag = getTokenFlag();
    try {
      const listResult = await clawCmd(buildCmd("cron list", tokenFlag, "--json"), { quiet: true });
      const jobs = parseJobsFromCronList(listResult?.stdout);
      const existing = findCronJob(jobs);
      if (!existing) {
        return res.json({ ok: true, skipped: true, reason: "not registered" });
      }
      const rmResult = await clawCmd(buildCmd("cron rm", tokenFlag, shellEscape(String(existing.id || ""))), {
        quiet: true,
      });
      if (!rmResult?.ok) {
        return res.status(500).json({ ok: false, error: String(rmResult?.stderr || "cron rm failed") });
      }
      res.json({ ok: true, removed: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || "Internal error") });
    }
  });
};

module.exports = { registerXListIngestRoutes };
