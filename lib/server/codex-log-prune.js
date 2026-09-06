const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  OPENCLAW_DIR,
  kCodexLogRetentionDays,
  kCodexLogPruneIntervalMs,
  kCodexLogPruneEnabled,
  kCodexLogPruneBootDelayMs,
  kCodexLogVacuumSlackThresholdBytes,
  kCodexLogPruneBusyTimeoutMs,
} = require("./constants");

// OpenClaw's Codex plugin runs the Codex app-server with CODEX_HOME pointed at
// `<OPENCLAW_DIR>/agents/<agentId>/agent/codex-home/`. Its debug-log database
// (`logs_2.sqlite`, table `logs`, `ts` in unix seconds) grows ~130 MB/day and
// Codex exposes no retention knob, so a 5 GB volume fills in well under a
// fortnight. This module deletes rows older than the retention window, checkpoints
// the WAL, and VACUUMs only when the file is big enough for the rewrite to pay for
// itself. It is deliberately total: every failure path logs and returns, so a
// scheduler tick can never throw into the event loop or kill the boot sequence.

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

/** Truncating checkpoint: without it the deletes/rewrite just pile up in the WAL. */
const checkpointWal = ({ db, dbPath, label, logger }) => {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    logger.warn(
      `${kLogPrefix} wal_checkpoint (${label}) failed for ${dbPath}: ${error.message}`,
    );
  }
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

/**
 * Prune one Codex log database. Never throws: unopenable/busy databases come
 * back as `{ status: "skipped" }` and are retried on the next tick.
 */
const pruneCodexLogDatabase = ({
  dbPath,
  retentionDays = kCodexLogRetentionDays,
  vacuumSlackThresholdBytes = kCodexLogVacuumSlackThresholdBytes,
  busyTimeoutMs = kCodexLogPruneBusyTimeoutMs,
  now = Date.now(),
  fsModule = fs,
  logger = console,
} = {}) => {
  const bytesBefore = databaseBytes(dbPath, fsModule);
  const result = {
    path: dbPath,
    status: "ok",
    deleted: 0,
    bytesBefore,
    bytesAfter: bytesBefore,
    slackBytes: 0,
    vacuumed: false,
    reason: null,
  };

  let db = null;
  try {
    db = new DatabaseSync(dbPath);
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
    const info = db.prepare("DELETE FROM logs WHERE ts < ?").run(cutoffSeconds);
    result.deleted = Number(info?.changes ?? 0);

    // Fold the deletes into the main file before measuring the freelist.
    checkpointWal({ db, dbPath, label: "post-delete", logger });

    // VACUUM rewrites the entire file, so gate it on how much space is actually
    // reclaimable rather than on file size. It needs an exclusive lock — the
    // Codex app-server may be writing, so SQLITE_BUSY here is expected and
    // harmless; the next tick retries.
    result.slackBytes = reclaimableBytes(db);
    if (result.slackBytes > vacuumSlackThresholdBytes) {
      try {
        db.exec("VACUUM");
        result.vacuumed = true;
        // VACUUM's rebuild lands in the WAL — without a second truncating
        // checkpoint the reclaimed space just moves to logs_2.sqlite-wal
        // (measured: a 142 MB WAL left behind) and the volume never recovers.
        checkpointWal({ db, dbPath, label: "post-vacuum", logger });
      } catch (error) {
        result.reason = `vacuum skipped: ${error.message}`;
        logger.warn(
          `${kLogPrefix} VACUUM skipped for ${dbPath} (busy, retrying next tick): ${error.message}`,
        );
      }
    }
  } catch (error) {
    result.status = "skipped";
    result.reason = error.message;
    logger.warn(
      `${kLogPrefix} skipped ${dbPath} (busy, retrying next tick): ${error.message}`,
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
        `${retentionDays}d, ${bytesBefore} → ${result.bytesAfter} bytes ` +
        `(reclaimable ${result.slackBytes} bytes)` +
        `${result.vacuumed ? " (vacuumed)" : ""}`,
    );
  }
  return result;
};

/** One sweep over every discovered database. Never throws. */
const runCodexLogPrune = ({
  openclawDir = OPENCLAW_DIR,
  retentionDays = kCodexLogRetentionDays,
  vacuumSlackThresholdBytes = kCodexLogVacuumSlackThresholdBytes,
  busyTimeoutMs = kCodexLogPruneBusyTimeoutMs,
  now = Date.now(),
  fsModule = fs,
  logger = console,
} = {}) => {
  const summary = {
    ranAt: new Date(now).toISOString(),
    databases: 0,
    deleted: 0,
    bytesFreed: 0,
    skipped: 0,
    vacuumed: 0,
    results: [],
    error: null,
  };

  try {
    const dbPaths = findCodexLogDatabases({ openclawDir, fsModule });
    summary.databases = dbPaths.length;
    for (const dbPath of dbPaths) {
      const result = pruneCodexLogDatabase({
        dbPath,
        retentionDays,
        vacuumSlackThresholdBytes,
        busyTimeoutMs,
        now,
        fsModule,
        logger,
      });
      summary.results.push(result);
      summary.deleted += result.deleted;
      summary.bytesFreed += Math.max(0, result.bytesBefore - result.bytesAfter);
      if (result.status === "skipped") summary.skipped += 1;
      if (result.vacuumed) summary.vacuumed += 1;
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

  const tick = () => {
    try {
      runPrune({
        openclawDir,
        retentionDays,
        vacuumSlackThresholdBytes,
        fsModule,
        logger,
      });
    } catch (error) {
      // runCodexLogPrune already swallows everything; this guards an injected
      // implementation that does not.
      logger.error(`${kLogPrefix} tick failed (non-fatal): ${error.message}`);
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
};
