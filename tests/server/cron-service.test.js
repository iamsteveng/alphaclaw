const path = require("path");
const { spawnSync } = require("child_process");
const { createCronService } = require("../../lib/server/cron-service");

const makeService = (clawCmdImpl, usageFn) =>
  createCronService({
    clawCmd: clawCmdImpl,
    OPENCLAW_DIR: "/tmp",
    getSessionUsageByKeyPattern: usageFn ?? vi.fn(() => ({})),
  });

const okResponse = (data) => ({
  ok: true,
  stdout: typeof data === "string" ? data : JSON.stringify(data),
});

describe("server/cron-service", () => {
  it("uses plain cron commands without --json for run/toggle/edit", async () => {
    const clawCmd = vi
      .fn()
      .mockResolvedValueOnce(okResponse("ran job-a"))
      .mockResolvedValueOnce(okResponse("disabled job-a"))
      .mockResolvedValueOnce(okResponse("enabled job-a"))
      .mockResolvedValueOnce(okResponse({ id: "job-a", payload: { kind: "agentTurn" } }))
      .mockResolvedValueOnce(okResponse("updated prompt"))
      .mockResolvedValueOnce(okResponse("updated routing"));

    const cronService = makeService(clawCmd);

    const runResult = await cronService.runJobNow("job-a");
    expect(clawCmd).toHaveBeenCalledTimes(1);
    expect(clawCmd).toHaveBeenNthCalledWith(
      1,
      "cron run 'job-a'",
      expect.objectContaining({ quiet: true }),
    );
    expect(runResult.raw).toBe("ran job-a");

    const result = await cronService.setJobEnabled({ jobId: "job-a", enabled: false });
    expect(clawCmd).toHaveBeenCalledTimes(2);
    expect(clawCmd).toHaveBeenNthCalledWith(
      2,
      "cron disable 'job-a'",
      expect.objectContaining({ quiet: true }),
    );
    expect(result.raw).toBe("disabled job-a");
    expect(result.parsed).toBeNull();

    const secondResult = await cronService.setJobEnabled({ jobId: "job-a", enabled: true });
    expect(clawCmd).toHaveBeenCalledTimes(3);
    expect(clawCmd).toHaveBeenNthCalledWith(
      3,
      "cron enable 'job-a'",
      expect.objectContaining({ quiet: true }),
    );
    expect(secondResult.raw).toBe("enabled job-a");

    const promptResult = await cronService.updateJobPrompt({
      jobId: "job-a",
      message: "hello world",
    });
    expect(clawCmd).toHaveBeenCalledTimes(5);
    expect(clawCmd).toHaveBeenNthCalledWith(
      4,
      "cron show 'job-a' --json",
      expect.objectContaining({ quiet: true }),
    );
    expect(clawCmd).toHaveBeenNthCalledWith(
      5,
      "cron edit 'job-a' --message 'hello world'",
      expect.objectContaining({ quiet: true }),
    );
    expect(promptResult.raw).toBe("updated prompt");

    const routingResult = await cronService.updateJobRouting({
      jobId: "job-a",
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryTo: "123",
    });
    expect(clawCmd).toHaveBeenCalledTimes(6);
    expect(clawCmd).toHaveBeenNthCalledWith(
      6,
      "cron edit 'job-a' --session 'isolated' --wake 'next-heartbeat' --announce --channel 'telegram' --to '123'",
      expect.objectContaining({ quiet: true }),
    );
    expect(routingResult.raw).toBe("updated routing");
  });

  it("uses --system-event when editing main systemEvent job prompts", async () => {
    const clawCmd = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ id: "job-main", payload: { kind: "systemEvent" } }))
      .mockResolvedValueOnce(okResponse("updated prompt"));

    const cronService = makeService(clawCmd);

    const result = await cronService.updateJobPrompt({
      jobId: "job-main",
      message: "new prompt",
    });

    expect(clawCmd).toHaveBeenCalledTimes(2);
    expect(clawCmd).toHaveBeenNthCalledWith(
      1,
      "cron show 'job-main' --json",
      expect.objectContaining({ quiet: true }),
    );
    expect(clawCmd).toHaveBeenNthCalledWith(
      2,
      "cron edit 'job-main' --system-event 'new prompt'",
      expect.objectContaining({ quiet: true }),
    );
    expect(result.raw).toBe("updated prompt");
  });

  it("listJobs calls cron list --json and returns normalized jobs array", async () => {
    const rpcJobs = [
      {
        id: "job-a",
        name: "Job A",
        enabled: true,
        state: { nextRunAtMs: 9999 },
        payload: { kind: "agentTurn", message: "go" },
        delivery: {},
        schedule: { kind: "cron", expr: "0 8 * * *" },
      },
    ];
    const clawCmd = vi.fn().mockResolvedValue(okResponse({ jobs: rpcJobs, total: 1 }));
    const cronService = makeService(clawCmd);

    const result = await cronService.listJobs();

    expect(clawCmd).toHaveBeenCalledWith(
      "cron list --json",
      expect.objectContaining({ quiet: true }),
    );
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].id).toBe("job-a");
    expect(result.jobs[0].name).toBe("Job A");
  });

  it("getStatus calls cron status --json and returns enabled/jobs/nextWakeAtMs without enabledJobs", async () => {
    const clawCmd = vi.fn().mockResolvedValue(
      okResponse({
        enabled: true,
        storePath: "/data/cron",
        storage: "sqlite",
        sqlitePath: "/data/cron.db",
        jobs: 3,
        nextWakeAtMs: 1234567890,
      }),
    );
    const cronService = makeService(clawCmd);

    const result = await cronService.getStatus();

    expect(clawCmd).toHaveBeenCalledWith(
      "cron status --json",
      expect.objectContaining({ quiet: true }),
    );
    expect(result.enabled).toBe(true);
    expect(result.jobs).toBe(3);
    expect(result.nextWakeAtMs).toBe(1234567890);
    expect(result.enabledJobs).toBeUndefined();
  });

  it("getJobRuns calls cron runs --id and returns filtered sorted entries", async () => {
    const entries = [
      { ts: 200, jobId: "job-a", action: "finished", status: "ok", durationMs: 1000 },
      { ts: 100, jobId: "job-a", action: "finished", status: "error", durationMs: 500 },
    ];
    const clawCmd = vi.fn().mockResolvedValue(
      okResponse({ entries, total: 2, offset: 0, limit: 50, hasMore: false, nextOffset: null }),
    );
    const cronService = makeService(clawCmd);

    const result = await cronService.getJobRuns({
      jobId: "job-a",
      limit: 20,
      offset: 0,
      status: "all",
      deliveryStatus: "all",
      sortDir: "desc",
      query: "",
    });

    expect(clawCmd).toHaveBeenCalledWith(
      "cron runs --id 'job-a'",
      expect.objectContaining({ quiet: true }),
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].ts).toBe(200);
    expect(result.entries[1].ts).toBe(100);
    expect(result.total).toBe(2);
  });

  it("getJobRuns filters by status", async () => {
    const entries = [
      { ts: 200, jobId: "job-a", action: "finished", status: "ok" },
      { ts: 100, jobId: "job-a", action: "finished", status: "error" },
    ];
    const clawCmd = vi.fn().mockResolvedValue(okResponse({ entries, total: 2 }));
    const cronService = makeService(clawCmd);

    const result = await cronService.getJobRuns({
      jobId: "job-a",
      limit: 20,
      offset: 0,
      status: "ok",
      deliveryStatus: "all",
      sortDir: "desc",
      query: "",
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].status).toBe("ok");
  });

  it("getRunByTs returns entry matching given timestamp from cron runs --id", async () => {
    const entries = [
      { ts: 100, jobId: "job-a", action: "finished", status: "ok" },
      { ts: 200, jobId: "job-a", action: "finished", status: "error" },
    ];
    const clawCmd = vi.fn().mockResolvedValue(okResponse({ entries, total: 2 }));
    const cronService = makeService(clawCmd);

    const result = await cronService.getRunByTs({ jobId: "job-a", ts: 100 });

    expect(clawCmd).toHaveBeenCalledWith(
      "cron runs --id 'job-a'",
      expect.objectContaining({ quiet: true }),
    );
    expect(result).not.toBeNull();
    expect(result.ts).toBe(100);
    expect(result.status).toBe("ok");
  });

  it("getRunByTs returns null when timestamp not found", async () => {
    const clawCmd = vi.fn().mockResolvedValue(okResponse({ entries: [], total: 0 }));
    const cronService = makeService(clawCmd);
    const result = await cronService.getRunByTs({ jobId: "job-a", ts: 999 });
    expect(result).toBeNull();
  });

  it("readJobDurationStats computes avgDurationMs from cron runs --id --limit 200", async () => {
    const entries = [
      { ts: 1000, jobId: "job-a", action: "finished", status: "ok", durationMs: 1000 },
      { ts: 2000, jobId: "job-a", action: "finished", status: "ok", durationMs: 3000 },
    ];
    const clawCmd = vi.fn().mockResolvedValue(okResponse({ entries, total: 2 }));
    const usageFn = vi.fn(() => ({ totals: {} }));
    const cronService = makeService(clawCmd, usageFn);

    const result = await cronService.getJobUsage({ jobId: "job-a", sinceMs: 0 });

    expect(clawCmd).toHaveBeenCalledWith(
      "cron runs --id 'job-a' --limit 200",
      expect.objectContaining({ quiet: true }),
    );
    expect(result.totals.avgDurationMs).toBe(2000);
    expect(result.totals.durationSamples).toBe(2);
    expect(result.totals.totalDurationMs).toBe(4000);
  });

  it("getJobRunTrends returns time-bucketed points from cron runs --id --limit 200", async () => {
    const now = Date.now();
    const entries = [
      { ts: now - 1000, jobId: "job-a", action: "finished", status: "ok", durationMs: 500 },
    ];
    const clawCmd = vi.fn().mockResolvedValue(okResponse({ entries, total: 1 }));
    const cronService = makeService(clawCmd);

    const result = await cronService.getJobRunTrends({ jobId: "job-a", range: "7d" });

    expect(clawCmd).toHaveBeenCalledWith(
      "cron runs --id 'job-a' --limit 200",
      expect.objectContaining({ quiet: true }),
    );
    expect(result.points).toHaveLength(7);
    expect(result.bucket).toBe("day");
    expect(result.range).toBe("7d");
    const totalRunsAcrossBuckets = result.points.reduce((s, p) => s + p.totalRuns, 0);
    expect(totalRunsAcrossBuckets).toBe(1);
  });

  it("getBulkJobRuns returns entries per job using listJobs then cron runs --id", async () => {
    const jobEntry = { ts: 1000, jobId: "job-a", action: "finished", status: "ok", durationMs: 500 };
    const clawCmd = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          jobs: [{ id: "job-a", name: "Job A", enabled: true, state: {}, payload: {}, delivery: {}, schedule: {} }],
          total: 1,
        }),
      )
      .mockResolvedValueOnce(okResponse({ entries: [jobEntry], total: 1 }));

    const cronService = makeService(clawCmd);

    const result = await cronService.getBulkJobRuns({ sinceMs: 0, limitPerJob: 20 });

    expect(clawCmd).toHaveBeenNthCalledWith(1, "cron list --json", expect.objectContaining({ quiet: true }));
    expect(clawCmd).toHaveBeenNthCalledWith(2, "cron runs --id 'job-a'", expect.objectContaining({ quiet: true }));
    expect(result.byJobId["job-a"].entries).toHaveLength(1);
    expect(result.byJobId["job-a"].total).toBe(1);
  });

  it("getBulkJobUsage returns usage per job including duration stats from cron runs --id --limit 200", async () => {
    const runEntry = { ts: 1000, jobId: "job-a", action: "finished", status: "ok", durationMs: 2000 };
    const clawCmd = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          jobs: [{ id: "job-a", name: "Job A", enabled: true, state: {}, payload: {}, delivery: {}, schedule: {} }],
          total: 1,
        }),
      )
      .mockResolvedValueOnce(okResponse({ entries: [runEntry], total: 1 }));

    const usageFn = vi.fn(() => ({
      totals: { runCount: 1, totalTokens: 500, totalCost: 0.01 },
    }));
    const cronService = makeService(clawCmd, usageFn);

    const result = await cronService.getBulkJobUsage({ sinceMs: 0 });

    expect(clawCmd).toHaveBeenNthCalledWith(1, "cron list --json", expect.objectContaining({ quiet: true }));
    expect(clawCmd).toHaveBeenNthCalledWith(2, "cron runs --id 'job-a' --limit 200", expect.objectContaining({ quiet: true }));
    expect(result.byJobId["job-a"]).toBeDefined();
    expect(result.byJobId["job-a"].runCount).toBe(1);
    expect(result.byJobId["job-a"].totalTokens).toBe(500);
  });

  it("static analysis: no readCronStore / readJsonFile / kCronStoreFile / jobs.json / runs/ in cron-service.js", () => {
    const filePath = path.resolve(__dirname, "../../lib/server/cron-service.js");
    const result = spawnSync(
      "grep",
      ["-En", "readCronStore|readJsonFile|kCronStoreFile|jobs\\.json|runs/", filePath],
      { encoding: "utf8" },
    );
    expect(result.stdout.trim()).toBe("");
  });
});
