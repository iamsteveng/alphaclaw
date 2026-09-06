const fs = require("fs");
const path = require("path");
const { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const {
  OPENCLAW_DIR,
  kCodexLogRetentionDays,
  kCodexLogPruneIntervalMs,
  kCodexLogPruneEnabled,
  kCodexLogPruneBootDelayMs,
  kCodexLogVacuumSlackThresholdBytes,
  kCodexLogPruneBusyTimeoutMs,
  kCodexLogPruneBatchRows,
  kCodexLogPruneMaxBatches,
  kCodexLogPruneMaxSweepMs,
  kCodexLogPruneWalCeilingBytes,
  kCodexLogVacuumFreeSpaceMarginBytes,
} = require("./constants");

// OpenClaw's Codex plugin runs the Codex app-server with CODEX_HOME pointed at
// `<OPENCLAW_DIR>/agents/<agentId>/agent/codex-home/`. Its debug-log database
// (`logs_2.sqlite`, table `logs`, `ts` in unix seconds) grows ~130 MB/day and
// Codex exposes no retention knob, so a 5 GB volume fills in well under a
// fortnight. This module deletes rows older than the retention window, checkpoints
// the WAL, and VACUUMs only when the file is big enough for the rewrite to pay for
// itself. It is deliberately total: every failure path logs and returns, so a
// scheduler tick can never throw into the event loop or kill the boot sequence.
//
// The deletes are batched. A single `DELETE FROM logs WHERE ts < ?` over a
// multi-GB database dirties nearly every page, and in WAL mode every one of them
// is written to `logs_2.sqlite-wal` on the same volume before the transaction
// commits. On prod (1.33 GB database, 508 MB free, retention 1 day so ~95% of
// rows qualified) that failed outright with SQLITE_FULL — the prune needed more
// free space than the file it was trying to shrink. Deleting in bounded batches
// and truncating the WAL after each batch caps the sidecar at one batch's worth
// of pages, so the prune works on a volume that is already nearly full.

const kLogDbFileName = "logs_2.sqlite";
const kLogPrefix = "[codex-log-prune]";

let lastRun = null;
let timers = { boot: null, interval: null };

const fileBytes = (filePath, fsModule = fs) => {
  try {
    return fsModule.statSync(filePath).size;
  } catch {
    return 0;
  }
};

/** Bytes the database occupies on the volume: main file plus its WAL sidecars. */
const databaseBytes = (dbPath, fsModule = fs) =>
  fileBytes(dbPath, fsModule) +
  fileBytes(`${dbPath}-wal`, fsModule) +
  fileBytes(`${dbPath}-shm`, fsModule);

/**
 * Bytes available on the volume holding `dbPath`, or `null` when it cannot be
 * determined (`fs.statfsSync` needs Node >= 18.15, and can fail on exotic
 * mounts). `null` means "unknown" and callers proceed as if unconstrained.
 */
const volumeFreeBytes = (dbPath, fsModule = fs) => {
  try {
    if (typeof fsModule.statfsSync !== "function") return null;
    const stats = fsModule.statfsSync(path.dirname(dbPath));
    const available = Number(stats?.bavail);
    const blockSize = Number(stats?.bsize);
    if (!Number.isFinite(available) || !Number.isFinite(blockSize)) return null;
    return available * blockSize;
  } catch {
    return null;
  }
};

/**
 * Every `agents/<agentId>/agent/codex-home/logs_2.sqlite` under `openclawDir`.
 * Missing directories are not an error — a fresh install has no agents yet.
 */
const findCodexLogDatabases = ({
  openclawDir = OPENCLAW_DIR,
  fsModule = fs,
} = {}) => {
  const agentsDir = path.join(openclawDir, "agents");
  let entries = [];
  try {
    entries = fsModule.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dbPath = path.join(
      agentsDir,
      entry.name,
      "agent",
      "codex-home",
      kLogDbFileName,
    );
    try {
      if (fsModule.statSync(dbPath).isFile()) found.push(dbPath);
    } catch {
      // No codex-home for this agent — nothing to prune.
    }
  }
  return found.sort();
};

/**
 * Truncating checkpoint: without it the deletes/rewrite just pile up in the WAL.
 *
 * The result must be inspected, not discarded. `PRAGMA wal_checkpoint(TRUNCATE)`
 * does not throw when it cannot run — it returns `busy: 1` and leaves the WAL
 * exactly where it was. Any other connection holding a read transaction (the
 * Codex app-server tailing its own log) is enough to pin it, and a sweep that
 * ignores that keeps deleting while the WAL grows batch after batch: measured at
 * 158 MB of `-wal` for a 160 MB prune, reported as a clean run. On a volume with
 * 508 MB free that is the original failure wearing a different hat.
 *
 * Returns `{ ok, busy, log, checkpointed }`. In rollback-journal mode SQLite
 * answers `busy: 0, log: -1, checkpointed: -1` — not an error, there is simply
 * no WAL, so `ok` is true and the guard stays out of the way.
 */
const checkpointWal = ({ db, dbPath, label, logger }) => {
  try {
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() || {};
    const busy = Number(row.busy ?? 0);
    return {
      ok: busy === 0,
      busy,
      log: Number(row.log ?? 0),
      checkpointed: Number(row.checkpointed ?? 0),
    };
  } catch (error) {
    logger.warn(
      `${kLogPrefix} wal_checkpoint (${label}) failed for ${dbPath}: ${error.message}`,
    );
    return { ok: false, busy: 1, log: 0, checkpointed: 0, error: error.message };
  }
};

/**
 * Which kind of "come back later" a SQLite failure is.
 *
 * SQLITE_FULL is not SQLITE_BUSY: the first prod run reported a full volume as
 * "busy", which pointed the investigation at lock contention instead of at the
 * WAL blowing out the disk. Keep them distinct so the log names the real cause.
 */
const classifySqliteError = (error) => {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  if (code === "SQLITE_FULL" || /database or disk is full/i.test(message)) {
    return "disk-full";
  }
  if (
    code === "SQLITE_BUSY" ||
    /database is locked|database table is locked|SQLITE_BUSY/i.test(message)
  ) {
    return "busy";
  }
  return "error";
};

/**
 * Bytes VACUUM could actually reclaim: pages on the freelist. File size is a
 * poor proxy — a 1 GB DB that is all live rows has nothing to give back, and
 * rewriting it costs a full-size temp copy for no gain.
 */
const reclaimableBytes = (db) => {
  const freelist = Number(
    db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
  );
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 0);
  return freelist * pageSize;
};

const hasLogsTable = (db) => {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'",
    )
    .get();
  return !!row;
};

/** Hand the event loop back so the dashboard and watchdog stay responsive. */
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Prune one Codex log database. Never throws: unopenable/busy/full databases
 * come back as `{ status: "skipped" }` and are retried on the next tick.
 *
 * Async because node:sqlite is synchronous — every batch blocks the event loop
 * for its duration, so the loop yields between batches rather than freezing the
 * HTTP server and watchdog for the whole sweep.
 */
const pruneCodexLogDatabase = async ({
  dbPath,
  retentionDays = kCodexLogRetentionDays,
  vacuumSlackThresholdBytes = kCodexLogVacuumSlackThresholdBytes,
  busyTimeoutMs = kCodexLogPruneBusyTimeoutMs,
  batchRows = kCodexLogPruneBatchRows,
  maxBatches = kCodexLogPruneMaxBatches,
  maxSweepMs = kCodexLogPruneMaxSweepMs,
  walCeilingBytes = kCodexLogPruneWalCeilingBytes,
  vacuumFreeSpaceMarginBytes = kCodexLogVacuumFreeSpaceMarginBytes,
  now = Date.now(),
  fsModule = fs,
  logger = console,
  // Injectable seams for tests: a stubbed database handle, a stubbed free-space
  // probe, a fake monotonic clock and a no-op yield.
  openDatabase = (target) => new DatabaseSync(target),
  freeSpaceBytes = volumeFreeBytes,
  // performance.now() is monotonic; Date.now() jumps with wall-clock/NTP
  // corrections, which could hand the sweep an instant or an endless deadline.
  monotonicNow = () => performance.now(),
  yieldImpl = yieldToEventLoop,
} = {}) => {
  const bytesBefore = databaseBytes(dbPath, fsModule);
  const result = {
    path: dbPath,
    status: "ok",
    deleted: 0,
    batches: 0,
    capped: false,
    walStuck: false,
    walBytes: 0,
    bytesBefore,
    bytesAfter: bytesBefore,
    slackBytes: 0,
    vacuumed: false,
    reason: null,
  };

  let db = null;
  try {
    db = openDatabase(dbPath);
  } catch (error) {
    result.status = "skipped";
    result.reason = error.message;
    logger.warn(
      `${kLogPrefix} skipped ${dbPath} (cannot open, retrying next tick): ${error.message}`,
    );
    return result;
  }

  try {
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 0}`);

    if (!hasLogsTable(db)) {
      result.status = "skipped";
      result.reason = "no logs table";
      logger.warn(`${kLogPrefix} skipped ${dbPath}: no \`logs\` table`);
      return result;
    }

    const cutoffSeconds = Math.floor(now / 1000) - retentionDays * 86400;
    const rowsPerBatch = Math.max(1, Number(batchRows) || 1);
    const batchCap = Math.max(1, Number(maxBatches) || 1);
    const walCeiling = Math.max(0, Number(walCeilingBytes) || 0);
    const deadline = monotonicNow() + Math.max(0, Number(maxSweepMs) || 0);

    // Delete by rowid so each statement touches a bounded, contiguous slice of
    // the file. `ORDER BY rowid` keeps the batches walking forward from the
    // oldest rows instead of re-scanning the whole ts range every time.
    const deleteBatch = db.prepare(
      "DELETE FROM logs WHERE rowid IN " +
        "(SELECT rowid FROM logs WHERE ts < ? ORDER BY rowid LIMIT ?)",
    );

    for (;;) {
      const info = deleteBatch.run(cutoffSeconds, rowsPerBatch);
      const changed = Number(info?.changes ?? 0);

      // Fold this batch into the main file immediately: the whole point of
      // batching is that the WAL never holds more than one batch of pages.
      const checkpoint = checkpointWal({
        db,
        dbPath,
        label: "post-delete",
        logger,
      });
      result.walBytes = fileBytes(`${dbPath}-wal`, fsModule);

      if (changed === 0) break;
      result.deleted += changed;
      result.batches += 1;

      // Verify the batching invariant actually held. If the checkpoint could
      // not truncate (a concurrent reader pins the WAL) or the sidecar is over
      // the ceiling anyway, continuing would grow the WAL by another batch on
      // every iteration — the exact disk-full failure this rewrite exists to
      // prevent. Stop, leave the rest to the next tick, and do not VACUUM.
      if (!checkpoint.ok || result.walBytes > walCeiling) {
        result.capped = true;
        result.walStuck = true;
        result.reason =
          `wal-not-truncating (checkpoint busy=${checkpoint.busy}, ` +
          `${result.walBytes} bytes in -wal, ceiling ${walCeiling})`;
        logger.warn(
          `${kLogPrefix} ${dbPath}: stopped early after ${result.batches} batches ` +
            `(${result.deleted} rows deleted) — WAL is not truncating ` +
            `(checkpoint busy=${checkpoint.busy}, -wal at ${result.walBytes} bytes, ` +
            `ceiling ${walCeiling}); skipping VACUUM, next tick retries`,
        );
        break;
      }

      if (result.batches >= batchCap || monotonicNow() >= deadline) {
        result.capped = true;
        result.reason =
          result.batches >= batchCap
            ? `batch cap reached (${batchCap} batches)`
            : `time budget reached (${maxSweepMs} ms)`;
        logger.warn(
          `${kLogPrefix} ${dbPath}: stopped early after ${result.batches} batches ` +
            `(${result.deleted} rows deleted) — ${result.reason}; next tick continues`,
        );
        break;
      }

      await yieldImpl();
    }

    // VACUUM rewrites the entire file, so gate it on how much space is actually
    // reclaimable rather than on file size. It needs an exclusive lock — the
    // Codex app-server may be writing, so SQLITE_BUSY here is expected and
    // harmless; the next tick retries.
    result.slackBytes = reclaimableBytes(db);
    if (result.walStuck) {
      // VACUUM's whole rebuild lands in the WAL, and the WAL is precisely what
      // is not draining. `result.reason` already names the cause.
    } else if (result.slackBytes > vacuumSlackThresholdBytes) {
      // The rebuild lands in the WAL on the same volume, so VACUUM needs about
      // the retained size free before it can finish. Without this pre-check a
      // nearly-full volume gets pushed the rest of the way full.
      const availableBytes = freeSpaceBytes(dbPath, fsModule);
      const retainedBytes = Math.max(
        0,
        fileBytes(dbPath, fsModule) - result.slackBytes,
      );
      const requiredBytes = retainedBytes + vacuumFreeSpaceMarginBytes;

      if (availableBytes !== null && availableBytes < requiredBytes) {
        result.reason =
          `vacuum skipped: ${availableBytes} bytes free on volume, ` +
          `needs ~${requiredBytes} (retained ${retainedBytes} + margin ` +
          `${vacuumFreeSpaceMarginBytes})`;
        logger.warn(
          `${kLogPrefix} VACUUM skipped for ${dbPath} (insufficient free space): ${result.reason}`,
        );
      } else {
        try {
          db.exec("VACUUM");
          result.vacuumed = true;
          // VACUUM's rebuild lands in the WAL — without a second truncating
          // checkpoint the reclaimed space just moves to logs_2.sqlite-wal
          // (measured: a 142 MB WAL left behind) and the volume never recovers.
          const checkpoint = checkpointWal({
            db,
            dbPath,
            label: "post-vacuum",
            logger,
          });
          result.walBytes = fileBytes(`${dbPath}-wal`, fsModule);
          if (!checkpoint.ok) {
            result.walStuck = true;
            result.reason =
              `vacuum rebuild left in -wal: checkpoint busy=${checkpoint.busy}, ` +
              `${result.walBytes} bytes in -wal`;
            logger.warn(`${kLogPrefix} ${dbPath}: ${result.reason}`);
          }
        } catch (error) {
          const kind = classifySqliteError(error);
          result.reason = `vacuum skipped: ${error.message}`;
          logger.warn(
            `${kLogPrefix} VACUUM skipped for ${dbPath} (${kind}, retrying next tick): ${error.message}`,
          );
        }
      }
    }
  } catch (error) {
    const kind = classifySqliteError(error);
    result.status = "skipped";
    result.skipKind = kind;
    result.reason = error.message;
    logger.warn(
      `${kLogPrefix} skipped ${dbPath} (${kind}, retrying next tick): ${error.message}`,
    );
  } finally {
    try {
      db.close();
    } catch {
      // Already closed / never fully opened.
    }
  }

  result.bytesAfter = databaseBytes(dbPath, fsModule);
  if (result.status === "ok") {
    logger.log(
      `${kLogPrefix} ${dbPath}: deleted ${result.deleted} rows older than ` +
        `${retentionDays}d in ${result.batches} batch(es), ` +
        `${bytesBefore} → ${result.bytesAfter} bytes ` +
        `(reclaimable ${result.slackBytes} bytes)` +
        `${result.vacuumed ? " (vacuumed)" : ""}` +
        `${result.capped ? " (incomplete — continues next tick)" : ""}`,
    );
  }
  return result;
};

/** One sweep over every discovered database. Never throws. */
const runCodexLogPrune = async ({
  openclawDir = OPENCLAW_DIR,
  retentionDays = kCodexLogRetentionDays,
  vacuumSlackThresholdBytes = kCodexLogVacuumSlackThresholdBytes,
  busyTimeoutMs = kCodexLogPruneBusyTimeoutMs,
  batchRows = kCodexLogPruneBatchRows,
  maxBatches = kCodexLogPruneMaxBatches,
  maxSweepMs = kCodexLogPruneMaxSweepMs,
  walCeilingBytes = kCodexLogPruneWalCeilingBytes,
  vacuumFreeSpaceMarginBytes = kCodexLogVacuumFreeSpaceMarginBytes,
  now = Date.now(),
  fsModule = fs,
  logger = console,
  freeSpaceBytes = volumeFreeBytes,
  prune = pruneCodexLogDatabase,
} = {}) => {
  const summary = {
    ranAt: new Date(now).toISOString(),
    databases: 0,
    deleted: 0,
    bytesFreed: 0,
    skipped: 0,
    vacuumed: 0,
    capped: 0,
    walStuck: 0,
    results: [],
    error: null,
  };

  try {
    const dbPaths = findCodexLogDatabases({ openclawDir, fsModule });
    summary.databases = dbPaths.length;
    for (const dbPath of dbPaths) {
      const result = await prune({
        dbPath,
        retentionDays,
        vacuumSlackThresholdBytes,
        busyTimeoutMs,
        batchRows,
        maxBatches,
        maxSweepMs,
        walCeilingBytes,
        vacuumFreeSpaceMarginBytes,
        now,
        fsModule,
        logger,
        freeSpaceBytes,
      });
      summary.results.push(result);
      summary.deleted += result.deleted;
      summary.bytesFreed += Math.max(0, result.bytesBefore - result.bytesAfter);
      if (result.status === "skipped") summary.skipped += 1;
      if (result.vacuumed) summary.vacuumed += 1;
      if (result.capped) summary.capped += 1;
      if (result.walStuck) summary.walStuck += 1;
    }
  } catch (error) {
    // Belt and braces: a sweep must never throw into a timer callback.
    summary.error = error.message;
    logger.error(`${kLogPrefix} sweep failed (non-fatal): ${error.message}`);
  }

  lastRun = summary;
  return summary;
};

const clearCodexLogPruneTimers = () => {
  if (timers.boot) clearTimeout(timers.boot);
  if (timers.interval) clearInterval(timers.interval);
  timers = { boot: null, interval: null };
};

/**
 * Schedule the sweep: once ~2 minutes after boot, then every
 * CODEX_LOG_PRUNE_INTERVAL_HOURS. Both timers are unref'd so they can never
 * hold the process open.
 */
const startCodexLogPrune = ({
  enabled = kCodexLogPruneEnabled,
  openclawDir = OPENCLAW_DIR,
  retentionDays = kCodexLogRetentionDays,
  intervalMs = kCodexLogPruneIntervalMs,
  bootDelayMs = kCodexLogPruneBootDelayMs,
  vacuumSlackThresholdBytes = kCodexLogVacuumSlackThresholdBytes,
  batchRows = kCodexLogPruneBatchRows,
  maxBatches = kCodexLogPruneMaxBatches,
  maxSweepMs = kCodexLogPruneMaxSweepMs,
  walCeilingBytes = kCodexLogPruneWalCeilingBytes,
  fsModule = fs,
  logger = console,
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  runPrune = runCodexLogPrune,
} = {}) => {
  clearCodexLogPruneTimers();

  if (!enabled) {
    logger.log(`${kLogPrefix} disabled (CODEX_LOG_PRUNE_ENABLED=false)`);
    return { started: false, stop: clearCodexLogPruneTimers };
  }

  const onTickFailure = (error) => {
    logger.error(`${kLogPrefix} tick failed (non-fatal): ${error.message}`);
  };

  const tick = () => {
    try {
      const outcome = runPrune({
        openclawDir,
        retentionDays,
        vacuumSlackThresholdBytes,
        batchRows,
        maxBatches,
        maxSweepMs,
        walCeilingBytes,
        fsModule,
        logger,
      });
      // The sweep is async now: a rejected promise would otherwise surface as an
      // unhandled rejection instead of a log line.
      if (outcome && typeof outcome.catch === "function") {
        outcome.catch(onTickFailure);
      }
    } catch (error) {
      // runCodexLogPrune already swallows everything; this guards an injected
      // implementation that does not.
      onTickFailure(error);
    }
  };

  timers.boot = setTimeoutImpl(tick, bootDelayMs);
  timers.interval = setIntervalImpl(tick, intervalMs);
  if (typeof timers.boot?.unref === "function") timers.boot.unref();
  if (typeof timers.interval?.unref === "function") timers.interval.unref();

  logger.log(
    `${kLogPrefix} scheduled: first sweep in ${Math.round(bootDelayMs / 1000)}s, ` +
      `then every ${Math.round(intervalMs / 3600000)}h (retention ${retentionDays}d)`,
  );
  return { started: true, stop: clearCodexLogPruneTimers };
};

/** Shape consumed by GET /api/status → `maintenance.codexLogPrune`. */
const getCodexLogPruneStatus = () => ({
  enabled: kCodexLogPruneEnabled,
  retentionDays: kCodexLogRetentionDays,
  intervalHours: Math.round(kCodexLogPruneIntervalMs / 3600000),
  lastRunAt: lastRun?.ranAt || null,
  lastResult: lastRun
    ? {
        databases: lastRun.databases,
        deleted: lastRun.deleted,
        bytesFreed: lastRun.bytesFreed,
        skipped: lastRun.skipped,
        vacuumed: lastRun.vacuumed,
        capped: lastRun.capped,
        walStuck: lastRun.walStuck,
        error: lastRun.error,
      }
    : null,
});

const resetCodexLogPruneState = () => {
  lastRun = null;
  clearCodexLogPruneTimers();
};

module.exports = {
  findCodexLogDatabases,
  pruneCodexLogDatabase,
  runCodexLogPrune,
  startCodexLogPrune,
  clearCodexLogPruneTimers,
  getCodexLogPruneStatus,
  resetCodexLogPruneState,
  classifySqliteError,
  volumeFreeBytes,
};
