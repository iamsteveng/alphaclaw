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
    it("deletes rows older than the retention window and keeps newer rows", async () => {
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
      const result = await pruneCodexLogDatabase({
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

    it("vacuums and shrinks the file when the delete frees more than the threshold", async () => {
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

      const result = await pruneCodexLogDatabase({
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

    it("truncates the WAL after vacuuming so the rebuild does not sit in -wal", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      db.exec("PRAGMA journal_mode = WAL");
      seedRows(db, { count: 2000, ts: nowSeconds - 30 * kDay, bodyBytes: 1024 });
      seedRows(db, { count: 10, ts: nowSeconds, bodyBytes: 1024 });
      db.close();

      const result = await pruneCodexLogDatabase({
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

    it("does not vacuum a large file with little reclaimable slack", async () => {
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

      const result = await pruneCodexLogDatabase({
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

    it("does not vacuum when the freed space is below the threshold", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.now();
      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 5, ts: Math.floor(now / 1000) - 30 * kDay });
      db.close();

      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        vacuumSlackThresholdBytes: 64 * 1024 * 1024,
        now,
        logger: silentLogger(),
      });

      expect(result.deleted).toBe(5);
      expect(result.vacuumed).toBe(false);
    });

    it("deletes everything across multiple batches and reports the total", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      db.exec("PRAGMA journal_mode = WAL");
      seedRows(db, { count: 50, ts: nowSeconds - 10 * kDay }); // old
      seedRows(db, { count: 7, ts: nowSeconds }); // keep
      db.close();

      const logger = silentLogger();
      const yieldImpl = vi.fn(() => Promise.resolve());
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        batchRows: 10,
        now,
        logger,
        yieldImpl,
      });

      expect(result.status).toBe("ok");
      expect(result.capped).toBe(false);
      expect(result.deleted).toBe(50);
      expect(result.batches).toBe(5);
      expect(rowCount(dbPath)).toBe(7);
      // One yield after every batch that deleted something — the loop hands the
      // event loop back so the dashboard and watchdog keep responding during a
      // long sweep instead of freezing for its whole duration.
      expect(yieldImpl).toHaveBeenCalledTimes(5);
      expect(logger.log.mock.calls[0][0]).toContain("deleted 50 rows");
      expect(logger.log.mock.calls[0][0]).toContain("5 batch(es)");
    });

    it("keeps the WAL bounded to a single batch while deleting", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      db.exec("PRAGMA journal_mode = WAL");
      seedRows(db, { count: 400, ts: nowSeconds - 10 * kDay, bodyBytes: 1024 });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      const walPath = `${dbPath}-wal`;
      let peakWalBytes = 0;
      const yieldImpl = vi.fn(() => {
        const bytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
        peakWalBytes = Math.max(peakWalBytes, bytes);
        return Promise.resolve();
      });

      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        batchRows: 20,
        // Keep VACUUM out of this measurement.
        vacuumSlackThresholdBytes: Number.MAX_SAFE_INTEGER,
        now,
        logger: silentLogger(),
        yieldImpl,
      });

      expect(result.deleted).toBe(400);
      expect(result.batches).toBe(20);
      // Every batch is checkpointed with TRUNCATE, so the sidecar is empty
      // between batches instead of accumulating the whole delete.
      expect(peakWalBytes).toBe(0);
    });

    it("stops the sweep when a concurrent reader pins the WAL", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      db.exec("PRAGMA journal_mode = WAL");
      seedRows(db, { count: 400, ts: nowSeconds - 10 * kDay, bodyBytes: 1024 });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      // A second connection holding an open read transaction — exactly what the
      // Codex app-server does while tailing its own log. For as long as it
      // lives, `PRAGMA wal_checkpoint(TRUNCATE)` returns busy=1 without
      // throwing, so a sweep that ignores the result keeps deleting while the
      // WAL grows by a batch per iteration.
      const reader = new DatabaseSync(dbPath);
      reader.exec("PRAGMA busy_timeout = 0");
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM logs").get();

      const logger = silentLogger();
      let result;
      try {
        result = await pruneCodexLogDatabase({
          dbPath,
          retentionDays: 3,
          batchRows: 20,
          busyTimeoutMs: 0,
          // VACUUM would otherwise be eligible — the guard must suppress it.
          vacuumSlackThresholdBytes: 0,
          now,
          logger,
        });
      } finally {
        try {
          reader.exec("ROLLBACK");
        } catch {
          // Already rolled back.
        }
        reader.close();
      }

      expect(result.capped).toBe(true);
      expect(result.walStuck).toBe(true);
      expect(result.reason).toContain("wal-not-truncating");
      expect(result.vacuumed).toBe(false);
      // Bailed after the first batch instead of pushing the whole 400-row
      // delete into -wal.
      expect(result.batches).toBe(1);
      expect(result.deleted).toBe(20);
      expect(rowCount(dbPath)).toBe(380);

      const walBytes = fs.existsSync(`${dbPath}-wal`)
        ? fs.statSync(`${dbPath}-wal`).size
        : 0;
      // Ceiling plus at most one batch's worth of pages.
      expect(walBytes).toBeLessThan(64 * 1024 * 1024 + 20 * 1024 * 8);

      const warnings = logger.warn.mock.calls.map((call) => call[0]);
      expect(warnings.some((line) => line.includes("WAL is not truncating"))).toBe(
        true,
      );
      expect(
        warnings.some((line) => line.includes(`${result.walBytes} bytes`)),
      ).toBe(true);
    });

    it("never fires the WAL guard when nothing is holding the WAL", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      db.exec("PRAGMA journal_mode = WAL");
      seedRows(db, { count: 400, ts: nowSeconds - 10 * kDay, bodyBytes: 1024 });
      seedRows(db, { count: 5, ts: nowSeconds, bodyBytes: 1024 });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        batchRows: 20,
        busyTimeoutMs: 0,
        vacuumSlackThresholdBytes: Number.MAX_SAFE_INTEGER,
        now,
        logger,
      });

      expect(result.walStuck).toBe(false);
      expect(result.capped).toBe(false);
      expect(result.deleted).toBe(400);
      expect(result.batches).toBe(20);
      expect(result.walBytes).toBe(0);
      expect(rowCount(dbPath)).toBe(5);
      expect(
        logger.warn.mock.calls.some((call) =>
          call[0].includes("not truncating"),
        ),
      ).toBe(false);
    });

    it("stops when the -wal file is over the ceiling despite a clean checkpoint", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      db.exec("PRAGMA journal_mode = WAL");
      seedRows(db, { count: 50, ts: nowSeconds - 10 * kDay });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      // The size half of the guard: a checkpoint that reports success but
      // leaves a huge sidecar behind is still a WAL that is not draining.
      const walPath = `${dbPath}-wal`;
      const fsModule = Object.assign({}, fs, {
        statSync: (target, ...rest) =>
          target === walPath
            ? { size: 200 * 1024 * 1024, isFile: () => true }
            : fs.statSync(target, ...rest),
      });

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        batchRows: 10,
        walCeilingBytes: 64 * 1024 * 1024,
        now,
        logger,
        fsModule,
      });

      expect(result.capped).toBe(true);
      expect(result.walStuck).toBe(true);
      expect(result.walBytes).toBe(200 * 1024 * 1024);
      expect(result.reason).toContain("wal-not-truncating");
      expect(result.batches).toBe(1);
      expect(result.deleted).toBe(10);
      expect(rowCount(dbPath)).toBe(40);
    });

    it("stops at the batch cap and reports partial progress", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 50, ts: nowSeconds - 10 * kDay });
      seedRows(db, { count: 7, ts: nowSeconds });
      db.close();

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        batchRows: 10,
        maxBatches: 2,
        now,
        logger,
      });

      expect(result.status).toBe("ok");
      expect(result.capped).toBe(true);
      expect(result.deleted).toBe(20);
      expect(result.batches).toBe(2);
      expect(result.reason).toContain("batch cap reached");
      // 30 old rows survive this tick and are picked up by the next one.
      expect(rowCount(dbPath)).toBe(37);
      expect(logger.warn.mock.calls[0][0]).toContain("stopped early");
    });

    it("stops when the wall-clock budget is exhausted", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 50, ts: nowSeconds - 10 * kDay });
      db.close();

      // Fake clock: the first reading sets the deadline, the second (taken after
      // batch one) is already past it.
      const readings = [0, 5000];
      let readIndex = 0;
      const monotonicNow = () =>
        readings[Math.min(readIndex++, readings.length - 1)];

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        batchRows: 10,
        maxSweepMs: 1000,
        now,
        logger,
        monotonicNow,
      });

      expect(result.capped).toBe(true);
      expect(result.batches).toBe(1);
      expect(result.deleted).toBe(10);
      expect(result.reason).toContain("time budget reached");
      expect(rowCount(dbPath)).toBe(40);
    });

    it("classifies a full volume as disk-full, not busy", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 20, ts: nowSeconds - 10 * kDay });
      db.close();

      // The prod failure: the DELETE cannot fit its pages in the WAL because
      // the volume is already full. SQLite reports SQLITE_FULL, which the first
      // implementation mislabelled as "busy".
      const openDatabase = (target) => {
        const real = new DatabaseSync(target);
        return {
          exec: (...args) => real.exec(...args),
          close: () => real.close(),
          prepare: (sql) => {
            if (sql.startsWith("DELETE FROM logs")) {
              return {
                run: () => {
                  throw new Error("database or disk is full");
                },
              };
            }
            return real.prepare(sql);
          },
        };
      };

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        now,
        logger,
        openDatabase,
      });

      expect(result.status).toBe("skipped");
      expect(result.skipKind).toBe("disk-full");
      expect(result.reason).toBe("database or disk is full");
      expect(result.deleted).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
      const warning = logger.warn.mock.calls.at(-1)[0];
      expect(warning).toContain("disk-full");
      expect(warning).not.toContain("(busy,");
      expect(warning).toContain("database or disk is full");
      // Rows survive for the next tick.
      expect(rowCount(dbPath)).toBe(20);
    });

    it("still classifies a locked database as busy", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 5, ts: nowSeconds - 10 * kDay });
      db.close();

      const openDatabase = (target) => {
        const real = new DatabaseSync(target);
        return {
          exec: (...args) => real.exec(...args),
          close: () => real.close(),
          prepare: (sql) => {
            if (sql.startsWith("DELETE FROM logs")) {
              return {
                run: () => {
                  throw new Error("database is locked");
                },
              };
            }
            return real.prepare(sql);
          },
        };
      };

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        now,
        logger,
        openDatabase,
      });

      expect(result.status).toBe("skipped");
      expect(result.skipKind).toBe("busy");
      expect(logger.warn.mock.calls.at(-1)[0]).toContain("(busy,");
    });

    it("skips VACUUM when the volume has too little free space for the rebuild", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 2000, ts: nowSeconds - 30 * kDay, bodyBytes: 1024 });
      seedRows(db, { count: 10, ts: nowSeconds, bodyBytes: 1024 });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      const bytesOnDisk = fs.statSync(dbPath).size;
      const logger = silentLogger();
      // VACUUM rebuilds through the WAL on the same volume; 4 KB is nowhere
      // near enough, so the rewrite must not be attempted.
      const freeSpaceBytes = vi.fn(() => 4096);

      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        vacuumSlackThresholdBytes: 512 * 1024,
        vacuumFreeSpaceMarginBytes: 1024 * 1024,
        now,
        logger,
        freeSpaceBytes,
      });

      expect(result.deleted).toBe(2000);
      expect(result.slackBytes).toBeGreaterThan(512 * 1024);
      expect(result.vacuumed).toBe(false);
      expect(freeSpaceBytes).toHaveBeenCalledWith(dbPath, fs);
      expect(result.reason).toContain("vacuum skipped");
      expect(result.reason).toContain("4096 bytes free");
      expect(
        logger.warn.mock.calls.some((call) =>
          call[0].includes("insufficient free space"),
        ),
      ).toBe(true);
      // The file was left alone, not rewritten.
      expect(fs.statSync(dbPath).size).toBe(bytesOnDisk);
    });

    it("vacuums when free space is unknown (statfs unavailable)", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const now = Date.UTC(2026, 8, 5, 12, 0, 0);
      const nowSeconds = Math.floor(now / 1000);

      const db = new DatabaseSync(dbPath);
      createCodexLogSchema(db);
      seedRows(db, { count: 2000, ts: nowSeconds - 30 * kDay, bodyBytes: 1024 });
      seedRows(db, { count: 10, ts: nowSeconds, bodyBytes: 1024 });
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();

      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        vacuumSlackThresholdBytes: 512 * 1024,
        now,
        logger: silentLogger(),
        freeSpaceBytes: () => null,
      });

      expect(result.vacuumed).toBe(true);
    });

    it("skips a file it cannot open without rejecting", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      fs.writeFileSync(dbPath, "this is not a sqlite database at all");

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        logger,
      });

      expect(result.status).toBe("skipped");
      expect(result.deleted).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("skips a database with no logs table without throwing", async () => {
      const dbPath = makeCodexLogDb(openclawDir);
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
      db.close();

      const logger = silentLogger();
      const result = await pruneCodexLogDatabase({
        dbPath,
        retentionDays: 3,
        logger,
      });

      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("no logs table");
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe("runCodexLogPrune", () => {
    it("sweeps every agent database and records the last run", async () => {
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

      const summary = await runCodexLogPrune({
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

    it("never rejects when discovery itself fails", async () => {
      const fsModule = {
        readdirSync: () => {
          throw new Error("EIO");
        },
        statSync: fs.statSync,
      };

      const logger = silentLogger();
      const summary = await runCodexLogPrune({ openclawDir, fsModule, logger });
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

    it("logs a rejected async sweep instead of leaking an unhandled rejection", async () => {
      const setTimeoutImpl = vi.fn(() => ({ unref: vi.fn() }));
      const setIntervalImpl = vi.fn(() => ({ unref: vi.fn() }));
      const logger = silentLogger();

      startCodexLogPrune({
        enabled: true,
        logger,
        setTimeoutImpl,
        setIntervalImpl,
        runPrune: () => Promise.reject(new Error("async boom")),
      });

      expect(() => setTimeoutImpl.mock.calls[0][0]()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(logger.error).toHaveBeenCalled();
      expect(logger.error.mock.calls[0][0]).toContain("async boom");
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
