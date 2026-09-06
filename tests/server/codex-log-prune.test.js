const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const {
  findCodexLogDatabases,
  pruneCodexLogDatabase,
  runCodexLogPrune,
  startCodexLogPrune,
  getCodexLogPruneStatus,
  resetCodexLogPruneState,
} = require("../../lib/server/codex-log-prune");
const { runOnboardedBootSequence } = require("../../lib/server/startup");

const kDay = 86400;

// The real Codex app-server schema (logs_2.sqlite).
const createCodexLogSchema = (db) => {
  db.exec("PRAGMA synchronous = OFF");
  db.exec(`
    CREATE TABLE _sqlx_migrations (
      version BIGINT PRIMARY KEY,
      description TEXT NOT NULL,
      installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      success BOOLEAN NOT NULL,
      checksum BLOB NOT NULL,
      execution_time BIGINT NOT NULL
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT NOT NULL,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT
    );
  `);
};

const seedRows = (db, { count, ts, bodyBytes = 32 }) => {
  // One transaction: 2k individually-committed inserts take ~20s on a slow disk.
  db.exec("BEGIN");
  const insert = db.prepare(
    "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, module_path, file, line, thread_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const body = "x".repeat(bodyBytes);
  for (let i = 0; i < count; i += 1) {
    insert.run(
      ts,
      0,
      "DEBUG",
      "codex_app_server",
      body,
      "codex::app_server",
      "app_server.rs",
      42,
      "main",
    );
  }
  db.exec("COMMIT");
};

const makeCodexLogDb = (openclawDir, agentId = "main") => {
  const dir = path.join(openclawDir, "agents", agentId, "agent", "codex-home");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "logs_2.sqlite");
};

const rowCount = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM logs").get().n);
  } finally {
    db.close();
  }
};

const silentLogger = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("server/codex-log-prune", () => {
  let tmpDir;
  let openclawDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-log-prune-"));
    openclawDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    resetCodexLogPruneState();
  });

  afterEach(() => {
    resetCodexLogPruneState();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("findCodexLogDatabases", () => {
    it("discovers logs_2.sqlite for every agent", () => {
      const main = makeCodexLogDb(openclawDir, "main");
      const other = makeCodexLogDb(openclawDir, "claude");
      fs.writeFileSync(main, "");
      fs.writeFileSync(other, "");
      // Agent without a codex-home must not appear.
      fs.mkdirSync(path.join(openclawDir, "agents", "idle", "agent"), {
        recursive: true,
      });

      expect(findCodexLogDatabases({ openclawDir })).toEqual([other, main].sort());
    });

    it("returns an empty list when the agents directory does not exist", () => {
      expect(
        findCodexLogDatabases({ openclawDir: path.join(tmpDir, "nope") }),
      ).toEqual([]);
    });
  });

  describe("pruneCodexLogDatabase", () => {
    it("deletes rows older than the retention window and keeps newer rows", () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 40, ts: nowSeconds - 10 * kDay }); // old
      seedRows(db, { count: 15, ts: nowSeconds - 4 * kDay }); // old (retention 3d)
      seedRows(db, { count: 25, ts: nowSeconds - 1 * kDay }); // keep
      seedRows(db, { count: 5, ts: nowSeconds }); // keep
      db.close();

      const logger = silentLogger();
      const result = pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        now,
        logger,
      });

      expect(result.status).toBe("ok");
      expect(result.deleted).toBe(55);
      expect(rowCount(dbPath)).toBe(30);
      const remaining = (() => {
        const handle = new DatabaseSync(dbPath);
        try {
          return Number(
            handle.prepare("SELECT MIN(ts) AS oldest FROM logs").get().oldest,
          );
        } finally {
          handle.close();
        }
      })();
      expect(remaining).toBe(nowSeconds - kDay);
      expect(logger.log).toHaveBeenCalledTimes(1);
      expect(logger.log.mock.calls[0][0]).toContain("deleted 55 rows");
      expect(logger.log.mock.calls[0][0]).toContain("reclaimable");
    });

    it("vacuums and shrinks the file when the delete frees more than the threshold", () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      // ~2 MB of old rows: the prune's own DELETE puts those pages on the
      // freelist, which is the slack VACUUM reclaims.
      seedRows(db, { count: 2000, ts: nowSeconds - 30 * kDay, bodyBytes: 1024 });
      seedRows(db, { count: 10, ts: nowSeconds, bodyBytes: 1024 });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      const bytesBefore = fs.statSync(dbPath).size;
      expect(bytesBefore).toBeGreaterThan(1024 * 1024);

      const result = pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        vacuumSlackThresholdBytes: 512 * 1024,
        now,
        logger: silentLogger(),
      });

      expect(result.vacuumed).toBe(true);
      expect(result.slackBytes).toBeGreaterThan(512 * 1024);
      expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
      expect(fs.statSync(dbPath).size).toBeLessThan(bytesBefore);
      expect(rowCount(dbPath)).toBe(10);
    });

    it("truncates the WAL after vacuuming so the rebuild does not sit in -wal", () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      db.exec("PRAGMA journal_mode = WAL");
      seedRows(db, { count: 2000, ts: nowSeconds - 30 * kDay, bodyBytes: 1024 });
      seedRows(db, { count: 10, ts: nowSeconds, bodyBytes: 1024 });
      db.close();

      const result = pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        vacuumSlackThresholdBytes: 512 * 1024,
        now,
        logger: silentLogger(),
      });

      expect(result.vacuumed).toBe(true);
      const walPath = `${dbPath}-wal`;
      const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      expect(walBytes).toBe(0);
    });

    it("does not vacuum a large file with little reclaimable slack", () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      // ~2 MB of live rows plus a handful of prunable ones: the file is large
      // but the delete frees almost nothing, so VACUUM is not worth the rewrite.
      seedRows(db, { count: 2000, ts: nowSeconds, bodyBytes: 1024 });
      seedRows(db, { count: 3, ts: nowSeconds - 30 * kDay, bodyBytes: 1024 });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      const bytesBefore = fs.statSync(dbPath).size;
      expect(bytesBefore).toBeGreaterThan(1024 * 1024);

      const result = pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        vacuumSlackThresholdBytes: 512 * 1024,
        now,
        logger: silentLogger(),
      });

      expect(result.deleted).toBe(3);
      expect(result.vacuumed).toBe(false);
      expect(result.slackBytes).toBeLessThan(512 * 1024);
      expect(rowCount(dbPath)).toBe(2000);
    });

    it("does not vacuum when the freed space is below the threshold", () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.now();
      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 5, ts: Math.floor(now / 1000) - 30 * kDay });
      db.close();

      const result = pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        vacuumSlackThresholdBytes: 64 * 1024 * 1024,
        now,
        logger: silentLogger(),
      });

      expect(result.deleted).toBe(5);
      expect(result.vacuumed).toBe(false);
    });

    it("skips a file it cannot open without throwing", () => {
      const dbPath = makeCodexLogDb(openclawDir);
      fs.writeFileSync(dbPath, "this is not a sqlite database at all");

      const logger = silentLogger();
      let result;
      expect(() => {
        result = pruneCodexLogDatabase({ dbPath, retentionDays: 3, logger });
      }).not.toThrow();

      expect(result.status).toBe("skipped");
      expect(result.deleted).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("skips a database with no logs table without throwing", () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
      db.close();

      const logger = silentLogger();
      const result = pruneCodexLogDatabase({ dbPath, retentionDays: 3, logger });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("no logs table");
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("runCodexLogPrune", () => {
    it("sweeps every agent database and records the last run", () => {
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      for (const agentId of ["main", "claude"]) {
        const dbPath = makeCodexLogDb(openclawDir, agentId);
        const db = new DatabaseSync(dbPath);
        createCodexLogSchema(db);
        seedRows(db, { count: 7, ts: nowSeconds - 9 * kDay });
        seedRows(db, { count: 3, ts: nowSeconds });
        db.close();
      }
      // A corrupt DB must be skipped, not fatal, and must not stop the sweep.
      const brokenPath = makeCodexLogDb(openclawDir, "broken");
      fs.writeFileSync(brokenPath, "corrupt");

      const summary = runCodexLogPrune({
        openclawDir,
        retentionDays: 3,
        now,
        logger: silentLogger(),
      });

      expect(summary.error).toBeNull();
      expect(summary.databases).toBe(3);
      expect(summary.deleted).toBe(14);
      expect(summary.skipped).toBe(1);
      expect(summary.ranAt).toBe(new Date(now).toISOString());

      const status = getCodexLogPruneStatus();
      expect(status.lastRunAt).toBe(new Date(now).toISOString());
      expect(status.lastResult).toEqual(
        expect.objectContaining({ databases: 3, deleted: 14, skipped: 1 }),
      );
    });

    it("never throws when discovery itself fails", () => {
      const fsModule = {
        readdirSync: () => {
          throw new Error("EIO");
        },
        statSync: fs.statSync,
      };

      const logger = silentLogger();
      let summary;
      expect(() => {
        summary = runCodexLogPrune({ openclawDir, fsModule, logger });
      }).not.toThrow();
      expect(summary.databases).toBe(0);
      expect(summary.results).toEqual([]);
    });
  });

  describe("startCodexLogPrune", () => {
    it("schedules one boot sweep and a recurring sweep with unref'd timers", () => {
      const bootTimer = { unref: vi.fn() };
      const intervalTimer = { unref: vi.fn() };
      const setTimeoutImpl = vi.fn(() => bootTimer);
      const setIntervalImpl = vi.fn(() => intervalTimer);
      const runPrune = vi.fn();

      const handle = startCodexLogPrune({
        enabled: true,
        openclawDir,
        retentionDays: 3,
        intervalMs: 24 * 60 * 60 * 1000,
        bootDelayMs: 2 * 60 * 1000,
        logger: silentLogger(),
        setTimeoutImpl,
        setIntervalImpl,
        runPrune,
      });

      expect(handle.started).toBe(true);
      expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
      expect(setTimeoutImpl.mock.calls[0][1]).toBe(2 * 60 * 1000);
      expect(setIntervalImpl).toHaveBeenCalledTimes(1);
      expect(setIntervalImpl.mock.calls[0][1]).toBe(24 * 60 * 60 * 1000);
      expect(bootTimer.unref).toHaveBeenCalledTimes(1);
      expect(intervalTimer.unref).toHaveBeenCalledTimes(1);

      // Nothing has run yet — only the boot timer firing triggers a sweep.
      expect(runPrune).not.toHaveBeenCalled();
      setTimeoutImpl.mock.calls[0][0]();
      expect(runPrune).toHaveBeenCalledTimes(1);
      expect(runPrune.mock.calls[0][0]).toEqual(
        expect.objectContaining({ openclawDir, retentionDays: 3 }),
      );
    });

    it("arms no timers when disabled", () => {
      const setTimeoutImpl = vi.fn();
      const setIntervalImpl = vi.fn();

      const handle = startCodexLogPrune({
        enabled: false,
        logger: silentLogger(),
        setTimeoutImpl,
        setIntervalImpl,
      });

      expect(handle.started).toBe(false);
      expect(setTimeoutImpl).not.toHaveBeenCalled();
      expect(setIntervalImpl).not.toHaveBeenCalled();
    });

    it("swallows a throwing sweep so the timer callback never rejects", () => {
      const setTimeoutImpl = vi.fn(() => ({ unref: vi.fn() }));
      const setIntervalImpl = vi.fn(() => ({ unref: vi.fn() }));
      const logger = silentLogger();

      startCodexLogPrune({
        enabled: true,
        logger,
        setTimeoutImpl,
        setIntervalImpl,
        runPrune: () => {
          throw new Error("boom");
        },
      });

      expect(() => setTimeoutImpl.mock.calls[0][0]()).not.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe("boot wiring", () => {
    const bootDeps = (overrides = {}) => ({
      runOpenclawDoctorMigration: vi.fn(() => ({ ran: false, ok: true })),
      ensureManagedExecDefaults: vi.fn(),
      ensureUsageTrackerPluginConfig: vi.fn(),
      ensureAcpAgentConfig: vi.fn(),
      ensureGatewayProviderConfig: vi.fn(),
      doSyncPromptFiles: vi.fn(),
      reloadEnv: vi.fn(),
      syncChannelConfig: vi.fn(),
      readEnvFile: vi.fn(() => []),
      ensureGatewayProxyConfig: vi.fn(),
      resolveSetupUrl: vi.fn(() => "https://setup.example.com"),
      startGateway: vi.fn(),
      watchdog: { start: vi.fn() },
      gmailWatchService: { start: vi.fn() },
      ...overrides,
    });

    it("starts the prune scheduler exactly once during the boot sequence", () => {
      const startCodexLogPruneScheduler = vi.fn(() => ({ started: true }));

      runOnboardedBootSequence(bootDeps({ startCodexLogPruneScheduler }));

      expect(startCodexLogPruneScheduler).toHaveBeenCalledTimes(1);
    });

    it("does not fail the boot when the scheduler throws", () => {
      const startCodexLogPruneScheduler = vi.fn(() => {
        throw new Error("scheduler exploded");
      });
      const deps = bootDeps({ startCodexLogPruneScheduler });

      expect(() => runOnboardedBootSequence(deps)).not.toThrow();
      expect(deps.gmailWatchService.start).toHaveBeenCalledTimes(1);
    });
  });
});
