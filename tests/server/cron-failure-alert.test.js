const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  formatCronFailureMessage,
  loadCronFailureAlertState,
  runCronFailureAlertPoll,
  startCronFailureAlert,
  getCronFailureAlertStatus,
  resetCronFailureAlertState,
} = require("../../lib/server/cron-failure-alert");

const kHour = 60 * 60 * 1000;
const kNow = Date.UTC(2026, 8, 6, 12, 0, 0);

let tmpDir;
let statePath;
let logger;

const makeLogger = () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/** `getBulkJobRuns` shape: { sinceMs, byJobId: { id: { entries, total } } }. */
const bulk = (byJobId) => ({
  sinceMs: 0,
  byJobId: Object.fromEntries(
    Object.entries(byJobId).map(([jobId, entries]) => [
      jobId,
      { entries, total: entries.length },
    ]),
  ),
});

const makeCronService = (byJobIdOrFn, names = {}) => ({
  getBulkJobRuns: vi.fn(async () =>
    typeof byJobIdOrFn === "function" ? byJobIdOrFn() : bulk(byJobIdOrFn),
  ),
  listJobs: vi.fn(async () => ({
    jobs: Object.entries(names).map(([id, name]) => ({ id, name })),
  })),
});

const makeNotifier = () => ({ notify: vi.fn(async () => ({ ok: true })) });

const poll = (overrides = {}) =>
  runCronFailureAlertPoll({
    now: kNow,
    statePath,
    logger,
    ...overrides,
  });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-failure-alert-"));
  statePath = path.join(tmpDir, "state", "cron-failure-alert-state.json");
  logger = makeLogger();
  resetCronFailureAlertState();
});

afterEach(() => {
  resetCronFailureAlertState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("server/cron-failure-alert — alerting", () => {
  it("alerts on a new error run", async () => {
    const cronService = makeCronService(
      {
        "trading-basing-watch": [
          {
            ts: kNow - 60_000,
            status: "error",
            error: "provider 400: model not supported",
            durationMs: 4210,
          },
        ],
      },
      { "trading-basing-watch": "Trading Basing Watch" },
    );
    const notifier = makeNotifier();

    const summary = await poll({ cronService, notifier });

    expect(summary.newFailures).toBe(1);
    expect(summary.alerted).toBe(1);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notifier.notify.mock.calls[0];
    expect(message).toBe(
      '🚨 Cron "Trading Basing Watch" failed at ' +
        `${new Date(kNow - 60_000).toISOString()} ` +
        "(4210 ms): provider 400: model not supported",
    );
    // Deliberately not "crash": that event type makes watchdog-notify.js capture
    // the Slack thread and reply later gateway "recovery" events into it.
    expect(opts).toEqual({ eventType: "cron-failure" });
  });

  it("alerts on completionStatus 'failed' even when status is not 'error'", async () => {
    const cronService = makeCronService({
      alpha: [
        {
          ts: kNow - 1000,
          status: "ok",
          completionStatus: "failed",
          error: "agent gave up",
          durationMs: 12,
        },
      ],
    });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify.mock.calls[0][0]).toContain("agent gave up");
  });

  it("truncates long error text to 300 characters", async () => {
    const longError = "x".repeat(500);
    const cronService = makeCronService({
      alpha: [{ ts: kNow - 1000, status: "error", error: longError, durationMs: 1 }],
    });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });

    const message = notifier.notify.mock.calls[0][0];
    expect(message).toContain(`${"x".repeat(300)}…`);
    expect(message).not.toContain("x".repeat(301));
  });

  it("ignores ok and skipped runs", async () => {
    const cronService = makeCronService({
      alpha: [
        { ts: kNow - 1000, status: "ok", durationMs: 10 },
        { ts: kNow - 2000, status: "skipped", durationMs: 0 },
      ],
    });
    const notifier = makeNotifier();

    const summary = await poll({ cronService, notifier });

    expect(summary.newFailures).toBe(0);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("batches multiple failing jobs into one message, one line per job", async () => {
    const cronService = makeCronService(
      {
        alpha: [{ ts: kNow - 1000, status: "error", error: "boom a", durationMs: 11 }],
        beta: [{ ts: kNow - 2000, status: "error", error: "boom b", durationMs: 22 }],
        gamma: [{ ts: kNow - 3000, status: "ok", durationMs: 33 }],
      },
      { alpha: "Alpha Job", beta: "Beta Job", gamma: "Gamma Job" },
    );
    const notifier = makeNotifier();

    const summary = await poll({ cronService, notifier });

    expect(summary.newFailures).toBe(2);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const lines = notifier.notify.mock.calls[0][0].split("\n");
    expect(lines[0]).toBe("🚨 2 cron jobs failed");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Alpha Job" failed at');
    expect(lines[1]).toContain("(11 ms): boom a");
    expect(lines[2]).toContain('"Beta Job" failed at');
    expect(lines[2]).toContain("(22 ms): boom b");
  });

  it("collapses several failures of the same job in one poll into one line", async () => {
    const cronService = makeCronService({
      alpha: [
        { ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 },
        { ts: kNow - 2000, status: "error", error: "boom", durationMs: 2 },
        { ts: kNow - 3000, status: "error", error: "boom", durationMs: 3 },
      ],
    });
    const notifier = makeNotifier();

    const summary = await poll({ cronService, notifier });

    expect(summary.newFailures).toBe(1);
    // The newest failure is the one reported.
    expect(notifier.notify.mock.calls[0][0]).toContain("(1 ms): boom");
  });

  it("falls back to the job id when the job name is unavailable", async () => {
    const cronService = makeCronService({
      "job-without-name": [
        { ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 },
      ],
    });
    cronService.listJobs = vi.fn(async () => {
      throw new Error("cron CLI unavailable");
    });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });

    expect(notifier.notify.mock.calls[0][0]).toContain('"job-without-name"');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("server/cron-failure-alert — de-duplication", () => {
  it("does not re-alert the same job/error within the de-dup window", async () => {
    const entries = [
      { ts: kNow - 1000, status: "error", error: "provider 400", durationMs: 1 },
    ];
    const cronService = makeCronService({ alpha: entries });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });
    expect(notifier.notify).toHaveBeenCalledTimes(1);

    // A later run of the same job with the same error, 30 minutes on.
    entries.unshift({
      ts: kNow + 30 * 60 * 1000,
      status: "error",
      error: "provider 400",
      durationMs: 2,
    });
    const summary = await poll({
      cronService,
      notifier,
      now: kNow + 30 * 60 * 1000 + 1000,
    });

    expect(summary.newFailures).toBe(1);
    expect(summary.suppressed).toBe(1);
    expect(summary.alerted).toBe(0);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("re-alerts the same error after the de-dup window has elapsed", async () => {
    const entries = [
      { ts: kNow - 1000, status: "error", error: "provider 400", durationMs: 1 },
    ];
    const cronService = makeCronService({ alpha: entries });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });

    const later = kNow + kHour + 60_000;
    entries.unshift({
      ts: later - 1000,
      status: "error",
      error: "provider 400",
      durationMs: 2,
    });
    const summary = await poll({ cronService, notifier, now: later });

    expect(summary.suppressed).toBe(0);
    expect(summary.alerted).toBe(1);
    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });

  it("re-alerts immediately when the error text changes", async () => {
    const entries = [
      { ts: kNow - 1000, status: "error", error: "provider 400", durationMs: 1 },
    ];
    const cronService = makeCronService({ alpha: entries });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });

    entries.unshift({
      ts: kNow + 60_000,
      status: "error",
      error: "provider 503: overloaded",
      durationMs: 2,
    });
    const summary = await poll({ cronService, notifier, now: kNow + 61_000 });

    expect(summary.suppressed).toBe(0);
    expect(notifier.notify).toHaveBeenCalledTimes(2);
    expect(notifier.notify.mock.calls[1][0]).toContain("provider 503: overloaded");
  });

  it("retries on the next poll when notification delivery throws", async () => {
    const entries = [
      { ts: kNow - 1000, status: "error", error: "provider 400", durationMs: 1 },
    ];
    const cronService = makeCronService({ alpha: entries });
    const notifier = {
      notify: vi
        .fn()
        .mockRejectedValueOnce(new Error("telegram down"))
        .mockResolvedValue({ ok: true }),
    };

    const first = await poll({ cronService, notifier });
    expect(first.alerted).toBe(0);
    expect(first.error).toBe("telegram down");

    // No de-dup marker was recorded, so the next failure alerts.
    entries.unshift({
      ts: kNow + 60_000,
      status: "error",
      error: "provider 400",
      durationMs: 2,
    });
    const second = await poll({ cronService, notifier, now: kNow + 61_000 });

    expect(second.alerted).toBe(1);
    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });
});

describe("server/cron-failure-alert — notificationsEnabled", () => {
  it("does not notify when notifications are disabled", async () => {
    const cronService = makeCronService({
      alpha: [{ ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 }],
    });
    const notifier = makeNotifier();

    const summary = await poll({
      cronService,
      notifier,
      isNotificationsEnabled: () => false,
    });

    expect(summary.newFailures).toBe(1);
    expect(summary.alerted).toBe(0);
    expect(summary.skipped).toBe("notifications_disabled");
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("surfaces the next failure once notifications are re-enabled", async () => {
    const entries = [
      { ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 },
    ];
    const cronService = makeCronService({ alpha: entries });
    const notifier = makeNotifier();

    await poll({ cronService, notifier, isNotificationsEnabled: () => false });

    entries.unshift({ ts: kNow + 60_000, status: "error", error: "boom", durationMs: 2 });
    const summary = await poll({ cronService, notifier, now: kNow + 61_000 });

    expect(summary.alerted).toBe(1);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("reports notifier_unavailable rather than throwing", async () => {
    const cronService = makeCronService({
      alpha: [{ ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 }],
    });

    const summary = await poll({ cronService, notifier: null });

    expect(summary.skipped).toBe("notifier_unavailable");
    expect(summary.error).toBeNull();
  });
});

describe("server/cron-failure-alert — watermark", () => {
  it("persists the watermark and does not re-alert the same run", async () => {
    const cronService = makeCronService({
      alpha: [{ ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 }],
    });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });

    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(persisted.watermarkByJobId.alpha).toBe(kNow - 1000);
    expect(persisted.lastPollAt).toBe(new Date(kNow).toISOString());
    expect(persisted.lastAlertAt).toBe(new Date(kNow).toISOString());

    // Same run seen again well past the de-dup window: the watermark, not the
    // de-dup map, is what stops the repeat alert.
    const summary = await poll({
      cronService,
      notifier,
      now: kNow + 5 * kHour,
    });
    expect(summary.newFailures).toBe(0);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("reloads the persisted watermark on start so a restart does not re-alert", async () => {
    const cronService = makeCronService({
      alpha: [{ ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 }],
    });
    const notifier = makeNotifier();

    await poll({ cronService, notifier });
    expect(notifier.notify).toHaveBeenCalledTimes(1);

    // Simulate a process restart: in-memory state gone, state file kept.
    resetCronFailureAlertState();
    const reloaded = loadCronFailureAlertState({ statePath, logger });
    expect(reloaded.loaded).toBe(true);
    expect(reloaded.watermarkByJobId.get("alpha")).toBe(kNow - 1000);

    startCronFailureAlert({
      cronService,
      notifier,
      statePath,
      logger,
      setTimeoutImpl: () => ({ unref: () => {} }),
      setIntervalImpl: () => ({ unref: () => {} }),
    });

    const summary = await poll({
      cronService,
      notifier,
      now: kNow + 5 * kHour,
    });
    expect(summary.newFailures).toBe(0);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("looks back at most the boot window when there is no watermark", async () => {
    const cronService = makeCronService({
      alpha: [
        // 45 minutes old — before the 30-minute boot look-back.
        { ts: kNow - 45 * 60 * 1000, status: "error", error: "stale", durationMs: 1 },
        // 5 minutes old — inside the window.
        { ts: kNow - 5 * 60 * 1000, status: "error", error: "fresh", durationMs: 2 },
      ],
    });
    const notifier = makeNotifier();

    const summary = await poll({ cronService, notifier });

    expect(summary.newFailures).toBe(1);
    expect(notifier.notify.mock.calls[0][0]).toContain("fresh");
    expect(notifier.notify.mock.calls[0][0]).not.toContain("stale");
  });

  it("requests run history no further back than the max look-back", async () => {
    const cronService = makeCronService({ alpha: [] });
    const notifier = makeNotifier();

    await poll({ cronService, notifier, maxLookbackMs: 2 * kHour });

    const { sinceMs } = cronService.getBulkJobRuns.mock.calls[0][0];
    expect(sinceMs).toBe(kNow - 30 * 60 * 1000);

    await poll({
      cronService,
      notifier,
      bootLookbackMs: 10 * kHour,
      maxLookbackMs: 2 * kHour,
    });
    expect(cronService.getBulkJobRuns.mock.calls[1][0].sinceMs).toBe(
      kNow - 2 * kHour,
    );
  });

  it("ignores an unreadable state file", () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{ not json");

    const result = loadCronFailureAlertState({ statePath, logger });

    expect(result.loaded).toBe(false);
    expect(result.watermarkByJobId.size).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps polling when the watermark cannot be persisted", async () => {
    const cronService = makeCronService({
      alpha: [{ ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 }],
    });
    const notifier = makeNotifier();
    const fsModule = {
      readFileSync: fs.readFileSync,
      mkdirSync: () => {
        throw new Error("read-only volume");
      },
      writeFileSync: () => {
        throw new Error("read-only volume");
      },
    };

    const summary = await poll({ cronService, notifier, fsModule });

    expect(summary.alerted).toBe(1);
    expect(summary.error).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("server/cron-failure-alert — resilience", () => {
  it("does not let a throwing cron service escape the poll", async () => {
    const cronService = {
      getBulkJobRuns: vi.fn(async () => {
        throw new Error("openclaw cron runs exited 1");
      }),
      listJobs: vi.fn(async () => ({ jobs: [] })),
    };
    const notifier = makeNotifier();

    const summary = await poll({ cronService, notifier });

    expect(summary.error).toBe("openclaw cron runs exited 1");
    expect(summary.alerted).toBe(0);
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(getCronFailureAlertStatus().lastPollAt).toBe(
      new Date(kNow).toISOString(),
    );
  });

  it("skips a tick while a previous poll is still awaiting the cron CLI", async () => {
    let releaseFirst;
    const pending = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const cronService = {
      getBulkJobRuns: vi
        .fn()
        .mockImplementationOnce(() => pending)
        .mockImplementation(async () =>
          bulk({ alpha: [{ ts: kNow, status: "ok", durationMs: 1 }] }),
        ),
      listJobs: vi.fn(async () => ({ jobs: [] })),
    };
    const notifier = makeNotifier();

    const first = poll({ cronService, notifier });
    await Promise.resolve();
    expect(cronService.getBulkJobRuns).toHaveBeenCalledTimes(1);

    // Second tick arrives while the first is still in flight.
    const second = await poll({ cronService, notifier });
    expect(second.skipped).toBe("poll_in_flight");
    expect(cronService.getBulkJobRuns).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalled();

    releaseFirst(bulk({ alpha: [] }));
    await first;

    // Once the first poll settles the guard is released.
    const third = await poll({ cronService, notifier, now: kNow + 1000 });
    expect(third.skipped).toBeNull();
    expect(cronService.getBulkJobRuns).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight guard when a poll fails", async () => {
    const cronService = {
      getBulkJobRuns: vi.fn(async () => {
        throw new Error("openclaw cron runs exited 1");
      }),
      listJobs: vi.fn(async () => ({ jobs: [] })),
    };
    const notifier = makeNotifier();

    await poll({ cronService, notifier });
    const second = await poll({ cronService, notifier });

    expect(second.skipped).toBeNull();
    expect(cronService.getBulkJobRuns).toHaveBeenCalledTimes(2);
  });

  it("tolerates a malformed getBulkJobRuns payload", async () => {
    const cronService = {
      getBulkJobRuns: vi.fn(async () => null),
      listJobs: vi.fn(async () => ({ jobs: [] })),
    };
    const notifier = makeNotifier();

    const summary = await poll({ cronService, notifier });

    expect(summary.jobsChecked).toBe(0);
    expect(summary.error).toBeNull();
  });
});

describe("server/cron-failure-alert — scheduler", () => {
  const makeTimerStubs = () => {
    const timeouts = [];
    const intervals = [];
    return {
      timeouts,
      intervals,
      setTimeoutImpl: vi.fn((fn, ms) => {
        const handle = { fn, ms, unref: vi.fn() };
        timeouts.push(handle);
        return handle;
      }),
      setIntervalImpl: vi.fn((fn, ms) => {
        const handle = { fn, ms, unref: vi.fn() };
        intervals.push(handle);
        return handle;
      }),
    };
  };

  it("arms an unref'd boot timeout and interval and polls on each", async () => {
    const stubs = makeTimerStubs();
    const runPoll = vi.fn(async () => ({}));
    const cronService = makeCronService({});
    const notifier = makeNotifier();

    const result = startCronFailureAlert({
      cronService,
      notifier,
      statePath,
      logger,
      bootDelayMs: 3 * 60 * 1000,
      intervalMs: 10 * 60 * 1000,
      runPoll,
      ...stubs,
    });

    expect(result.started).toBe(true);
    expect(stubs.timeouts).toHaveLength(1);
    expect(stubs.timeouts[0].ms).toBe(3 * 60 * 1000);
    expect(stubs.timeouts[0].unref).toHaveBeenCalled();
    expect(stubs.intervals).toHaveLength(1);
    expect(stubs.intervals[0].ms).toBe(10 * 60 * 1000);
    expect(stubs.intervals[0].unref).toHaveBeenCalled();

    stubs.timeouts[0].fn();
    stubs.intervals[0].fn();
    await Promise.resolve();
    expect(runPoll).toHaveBeenCalledTimes(2);
    expect(runPoll.mock.calls[0][0].cronService).toBe(cronService);
    expect(runPoll.mock.calls[0][0].notifier).toBe(notifier);
  });

  it("arms nothing when disabled", () => {
    const stubs = makeTimerStubs();

    const result = startCronFailureAlert({
      enabled: false,
      cronService: makeCronService({}),
      notifier: makeNotifier(),
      statePath,
      logger,
      ...stubs,
    });

    expect(result.started).toBe(false);
    expect(stubs.setTimeoutImpl).not.toHaveBeenCalled();
    expect(stubs.setIntervalImpl).not.toHaveBeenCalled();
  });

  it("arms nothing when the cron service is unavailable", () => {
    const stubs = makeTimerStubs();

    const result = startCronFailureAlert({
      cronService: null,
      notifier: makeNotifier(),
      statePath,
      logger,
      ...stubs,
    });

    expect(result.started).toBe(false);
    expect(stubs.setTimeoutImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("swallows a throwing injected poll implementation", async () => {
    const stubs = makeTimerStubs();
    const runPoll = vi.fn(() => {
      throw new Error("boom");
    });

    startCronFailureAlert({
      cronService: makeCronService({}),
      notifier: makeNotifier(),
      statePath,
      logger,
      runPoll,
      ...stubs,
    });

    expect(() => stubs.timeouts[0].fn()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("server/cron-failure-alert — status", () => {
  it("reports config, last poll, last alert and alerted jobs", async () => {
    const cronService = makeCronService(
      {
        alpha: [{ ts: kNow - 1000, status: "error", error: "boom", durationMs: 1 }],
      },
      { alpha: "Alpha Job" },
    );
    const notifier = makeNotifier();

    expect(getCronFailureAlertStatus()).toEqual({
      enabled: true,
      intervalMinutes: 10,
      lastPollAt: null,
      lastAlertAt: null,
      alertedJobs: [],
    });

    await poll({ cronService, notifier });

    expect(getCronFailureAlertStatus()).toEqual({
      enabled: true,
      intervalMinutes: 10,
      lastPollAt: new Date(kNow).toISOString(),
      lastAlertAt: new Date(kNow).toISOString(),
      alertedJobs: [
        {
          jobId: "alpha",
          name: "Alpha Job",
          lastAlertAt: new Date(kNow).toISOString(),
        },
      ],
    });
  });
});

describe("server/cron-failure-alert — formatCronFailureMessage", () => {
  it("uses the single-line form for one failure", () => {
    expect(
      formatCronFailureMessage([
        { jobName: "Alpha", ts: kNow, durationMs: 5, error: "boom" },
      ]),
    ).toBe(`🚨 Cron "Alpha" failed at ${new Date(kNow).toISOString()} (5 ms): boom`);
  });

  it("substitutes a placeholder when no error detail was reported", () => {
    expect(
      formatCronFailureMessage([
        { jobName: "Alpha", ts: kNow, durationMs: 5, error: "" },
      ]),
    ).toContain("no error detail reported");
  });
});
