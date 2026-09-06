const fs = require("fs");
const path = require("path");
const {
  kCronFailureAlertEnabled,
  kCronFailureAlertIntervalMs,
  kCronFailureAlertBootDelayMs,
  kCronFailureAlertBootLookbackMs,
  kCronFailureAlertMaxLookbackMs,
  kCronFailureAlertDedupWindowMs,
  kCronFailureAlertRunsPerJob,
  kCronFailureAlertErrorMaxChars,
  kCronFailureAlertStatePath,
} = require("./constants");
const { isTruthyFlag } = require("./utils/boolean");

// The watchdog only watches the gateway *process*. After the OpenClaw 2.0
// upgrade every scheduled cron on prod failed with a provider 400 ("model not
// supported") while the gateway itself stayed up and healthy, so nothing ever
// reached the operator. This module closes that gap: it polls cron run history
// on a timer and pushes failures through the same notifier the watchdog uses,
// so failing scheduled work is as loud as a crashed gateway.
//
// Everything here is deliberately total — a tick must never throw into the
// event loop, and a broken cron CLI must never take the server down. Failures
// are logged and retried on the next tick.

const kLogPrefix = "[cron-failure-alert]";
const kStateVersion = 1;

/** Module-level so `getCronFailureAlertStatus()` can report without a handle. */
let state = {
  /** jobId -> ms timestamp of the newest run already examined. Persisted. */
  watermarkByJobId: new Map(),
  /** jobId -> { errorKey, alertedAtMs, name }. In-memory only (de-dup window). */
  alertedByJobId: new Map(),
  lastPollAt: null,
  lastAlertAt: null,
};
let timers = { boot: null, interval: null };
/**
 * A poll awaits the cron CLI once per job, so a slow/hung CLI can easily outlast
 * the poll interval. Without this guard the next tick would run concurrently over
 * the same watermark and de-dup maps and could double-alert or lose a watermark.
 */
let pollInFlight = false;

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Default: honour the same flag `createWatchdogNotifier` callers honour. */
const defaultIsNotificationsEnabled = () =>
  !isTruthyFlag(process.env.WATCHDOG_NOTIFICATIONS_DISABLED);

// --------------------------------------------------------------------------
// Watermark persistence
// --------------------------------------------------------------------------

/**
 * Load the per-job watermark from disk. A missing/corrupt file is not an
 * error — it just means the next poll starts from the boot look-back window.
 */
const loadCronFailureAlertState = ({
  statePath = kCronFailureAlertStatePath,
  fsModule = fs,
  logger = console,
} = {}) => {
  const watermarkByJobId = new Map();
  let raw = "";
  try {
    raw = fsModule.readFileSync(statePath, "utf8");
  } catch {
    return { watermarkByJobId, loaded: false };
  }
  try {
    const parsed = JSON.parse(raw);
    const entries = parsed?.watermarkByJobId;
    if (entries && typeof entries === "object") {
      for (const [jobId, ts] of Object.entries(entries)) {
        const id = String(jobId || "").trim();
        const value = toFiniteNumber(ts, 0);
        if (id && value > 0) watermarkByJobId.set(id, value);
      }
    }
    state.lastPollAt = parsed?.lastPollAt || state.lastPollAt;
    state.lastAlertAt = parsed?.lastAlertAt || state.lastAlertAt;
  } catch (error) {
    logger.warn(
      `${kLogPrefix} ignoring unreadable state file ${statePath}: ${error.message}`,
    );
    return { watermarkByJobId, loaded: false };
  }
  return { watermarkByJobId, loaded: true };
};

/** Persist the watermark. Never throws — a read-only volume must not break polling. */
const saveCronFailureAlertState = ({
  statePath = kCronFailureAlertStatePath,
  fsModule = fs,
  logger = console,
} = {}) => {
  const payload = {
    version: kStateVersion,
    lastPollAt: state.lastPollAt,
    lastAlertAt: state.lastAlertAt,
    watermarkByJobId: Object.fromEntries(state.watermarkByJobId.entries()),
  };
  try {
    fsModule.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {
    // Directory already exists, or cannot be created — the write below reports.
  }
  try {
    fsModule.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch (error) {
    logger.warn(
      `${kLogPrefix} could not persist state to ${statePath}: ${error.message}`,
    );
    return false;
  }
};

// --------------------------------------------------------------------------
// Message formatting
// --------------------------------------------------------------------------

const truncateError = (value, maxChars = kCronFailureAlertErrorMaxChars) => {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "no error detail reported";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
};

const formatFailureLine = ({ jobName, ts, durationMs, error }) =>
  `"${jobName}" failed at ${new Date(toFiniteNumber(ts, 0)).toISOString()} ` +
  `(${toFiniteNumber(durationMs, 0)} ms): ${truncateError(error)}`;

/**
 * One failure → the single-line form. Several → one message, one line per job,
 * so a batch of failures does not fan out into a notification storm.
 */
const formatCronFailureMessage = (failures = []) => {
  if (failures.length === 1) return `🚨 Cron ${formatFailureLine(failures[0])}`;
  const lines = failures.map((failure) => `• ${formatFailureLine(failure)}`);
  return [`🚨 ${failures.length} cron jobs failed`, ...lines].join("\n");
};

// --------------------------------------------------------------------------
// Polling
// --------------------------------------------------------------------------

const isFailedRun = (entry) =>
  String(entry?.status || "") === "error" ||
  String(entry?.completionStatus || "") === "failed";

/**
 * Lowest timestamp worth asking the cron CLI for. The union of every known
 * watermark (so no job's history is missed), floored at `maxLookbackMs` so a
 * long-idle instance cannot ask for an unbounded slice of run history.
 */
const resolveSinceMs = ({ nowMs, bootFloorMs, maxLookbackMs }) => {
  let since = bootFloorMs;
  for (const ts of state.watermarkByJobId.values()) {
    if (ts < since) since = ts;
  }
  return Math.max(since, nowMs - maxLookbackMs);
};

/** Job id -> display name. Best effort: an unavailable list falls back to ids. */
const loadJobNames = async ({ cronService, logger }) => {
  const names = new Map();
  try {
    const result = await cronService.listJobs({ sortBy: "name", sortDir: "asc" });
    for (const job of Array.isArray(result?.jobs) ? result.jobs : []) {
      const id = String(job?.id || "").trim();
      if (!id) continue;
      names.set(id, String(job?.name || "").trim() || id);
    }
  } catch (error) {
    logger.warn(`${kLogPrefix} could not read job names: ${error.message}`);
  }
  return names;
};

/**
 * One poll. Reads every job's runs since its watermark, alerts on new failures,
 * advances the watermark, and persists it. Never throws.
 *
 * De-duplication: at most one alert per job per `dedupWindowMs` for the *same*
 * error text. A different error re-alerts immediately — a job whose failure mode
 * changed is new information; the same 400 repeating every 10 minutes is not.
 *
 * Only one poll runs at a time: a tick that arrives while the previous poll is
 * still awaiting the cron CLI returns `{ skipped: "poll_in_flight" }` rather than
 * racing it over the shared watermark and de-dup state.
 */
const runCronFailureAlertPoll = async ({
  cronService,
  notifier,
  isNotificationsEnabled = defaultIsNotificationsEnabled,
  now = Date.now(),
  bootLookbackMs = kCronFailureAlertBootLookbackMs,
  maxLookbackMs = kCronFailureAlertMaxLookbackMs,
  dedupWindowMs = kCronFailureAlertDedupWindowMs,
  limitPerJob = kCronFailureAlertRunsPerJob,
  statePath = kCronFailureAlertStatePath,
  fsModule = fs,
  logger = console,
} = {}) => {
  const summary = {
    polledAt: new Date(now).toISOString(),
    jobsChecked: 0,
    newFailures: 0,
    alerted: 0,
    suppressed: 0,
    notified: false,
    skipped: null,
    error: null,
  };

  if (pollInFlight) {
    summary.skipped = "poll_in_flight";
    if (typeof logger.debug === "function") {
      logger.debug(
        `${kLogPrefix} skipping tick: previous poll still in flight`,
      );
    }
    return summary;
  }
  pollInFlight = true;

  try {
    const bootFloorMs = now - bootLookbackMs;
    const sinceMs = resolveSinceMs({ nowMs: now, bootFloorMs, maxLookbackMs });
    const bulk = await cronService.getBulkJobRuns({
      sinceMs,
      status: "all",
      limitPerJob,
    });
    const byJobId =
      bulk?.byJobId && typeof bulk.byJobId === "object" ? bulk.byJobId : {};
    const jobIds = Object.keys(byJobId);
    summary.jobsChecked = jobIds.length;

    const jobNames = jobIds.length
      ? await loadJobNames({ cronService, logger })
      : new Map();

    const failures = [];
    for (const jobId of jobIds) {
      const entries = Array.isArray(byJobId[jobId]?.entries)
        ? byJobId[jobId].entries
        : [];
      // No watermark yet (fresh install, or a job first seen this poll): only
      // look back `bootLookbackMs`, so a restart never replays old failures.
      const watermark = state.watermarkByJobId.has(jobId)
        ? state.watermarkByJobId.get(jobId)
        : bootFloorMs;
      let newest = watermark;
      for (const entry of entries) {
        const ts = toFiniteNumber(entry?.ts, 0);
        if (ts > newest) newest = ts;
        if (ts <= watermark) continue;
        if (!isFailedRun(entry)) continue;
        failures.push({
          jobId,
          jobName: jobNames.get(jobId) || jobId,
          ts,
          durationMs: toFiniteNumber(entry?.durationMs, 0),
          error: entry?.error,
        });
      }
      state.watermarkByJobId.set(jobId, newest);
    }

    // Newest failure per job wins — a job that failed three times since the last
    // poll produces one line, not three.
    const latestByJobId = new Map();
    for (const failure of failures) {
      const existing = latestByJobId.get(failure.jobId);
      if (!existing || failure.ts > existing.ts) {
        latestByJobId.set(failure.jobId, failure);
      }
    }
    summary.newFailures = latestByJobId.size;

    const toAlert = [];
    for (const failure of latestByJobId.values()) {
      const errorKey = truncateError(failure.error);
      const previous = state.alertedByJobId.get(failure.jobId);
      const withinWindow =
        previous &&
        previous.errorKey === errorKey &&
        now - toFiniteNumber(previous.alertedAtMs, 0) < dedupWindowMs;
      if (withinWindow) {
        summary.suppressed += 1;
        continue;
      }
      toAlert.push({ failure, errorKey });
    }

    state.lastPollAt = new Date(now).toISOString();

    if (toAlert.length > 0) {
      if (!isNotificationsEnabled()) {
        summary.skipped = "notifications_disabled";
      } else if (!notifier?.notify) {
        summary.skipped = "notifier_unavailable";
      } else {
        const message = formatCronFailureMessage(
          toAlert.map((item) => item.failure),
        );
        try {
          // Deliberately NOT "crash": watchdog-notify.js's Slack path stores the
          // thread ts for a "crash" event and later replies gateway "recovery"
          // messages into it. A distinct event type keeps cron failures out of
          // that gateway-lifecycle thread (and out of its ❌/✅ reactions).
          await notifier.notify(message, { eventType: "cron-failure" });
          summary.notified = true;
        } catch (error) {
          // Delivery failed — do not record the de-dup marker, so the next tick
          // retries instead of silently swallowing the failure.
          summary.error = error.message;
          logger.error(
            `${kLogPrefix} notification failed (non-fatal): ${error.message}`,
          );
        }
        if (summary.notified) {
          summary.alerted = toAlert.length;
          state.lastAlertAt = state.lastPollAt;
          for (const { failure, errorKey } of toAlert) {
            state.alertedByJobId.set(failure.jobId, {
              errorKey,
              alertedAtMs: now,
              name: failure.jobName,
            });
          }
          logger.log(
            `${kLogPrefix} alerted on ${toAlert.length} failing cron job(s)`,
          );
        }
      }
      // A disabled/unavailable notifier still advances nothing: the de-dup map
      // stays empty so re-enabling notifications surfaces the next failure.
      if (summary.skipped) {
        logger.log(
          `${kLogPrefix} ${toAlert.length} failing cron job(s) not notified (${summary.skipped})`,
        );
      }
    }

    saveCronFailureAlertState({ statePath, fsModule, logger });
  } catch (error) {
    // Belt and braces: a poll must never throw into a timer callback.
    summary.error = error.message;
    state.lastPollAt = new Date(now).toISOString();
    logger.error(`${kLogPrefix} poll failed (non-fatal): ${error.message}`);
  } finally {
    pollInFlight = false;
  }

  return summary;
};

// --------------------------------------------------------------------------
// Scheduling
// --------------------------------------------------------------------------

const clearCronFailureAlertTimers = () => {
  if (timers.boot) clearTimeout(timers.boot);
  if (timers.interval) clearInterval(timers.interval);
  timers = { boot: null, interval: null };
};

/**
 * Schedule polling: once ~3 minutes after boot (so the gateway has settled and
 * the first cron runs of the new process have a chance to land), then every
 * CRON_FAILURE_ALERT_INTERVAL_MINUTES. Both timers are unref'd so they can
 * never hold the process open.
 */
const startCronFailureAlert = ({
  enabled = kCronFailureAlertEnabled,
  cronService,
  notifier,
  isNotificationsEnabled = defaultIsNotificationsEnabled,
  intervalMs = kCronFailureAlertIntervalMs,
  bootDelayMs = kCronFailureAlertBootDelayMs,
  statePath = kCronFailureAlertStatePath,
  fsModule = fs,
  logger = console,
  setTimeoutImpl = setTimeout,
  setIntervalImpl = setInterval,
  runPoll = runCronFailureAlertPoll,
} = {}) => {
  clearCronFailureAlertTimers();

  if (!enabled) {
    logger.log(`${kLogPrefix} disabled (CRON_FAILURE_ALERT_ENABLED=false)`);
    return { started: false, stop: clearCronFailureAlertTimers };
  }
  if (!cronService?.getBulkJobRuns) {
    logger.warn(`${kLogPrefix} not started: cron service unavailable`);
    return { started: false, stop: clearCronFailureAlertTimers };
  }

  // Reload the watermark so a restart does not re-alert failures already sent.
  const { watermarkByJobId } = loadCronFailureAlertState({
    statePath,
    fsModule,
    logger,
  });
  state.watermarkByJobId = watermarkByJobId;

  const tick = () => {
    Promise.resolve()
      .then(() =>
        runPoll({
          cronService,
          notifier,
          isNotificationsEnabled,
          statePath,
          fsModule,
          logger,
        }),
      )
      .catch((error) => {
        // runCronFailureAlertPoll already swallows everything; this guards an
        // injected implementation that does not.
        logger.error(`${kLogPrefix} tick failed (non-fatal): ${error.message}`);
      });
  };

  timers.boot = setTimeoutImpl(tick, bootDelayMs);
  timers.interval = setIntervalImpl(tick, intervalMs);
  if (typeof timers.boot?.unref === "function") timers.boot.unref();
  if (typeof timers.interval?.unref === "function") timers.interval.unref();

  logger.log(
    `${kLogPrefix} scheduled: first poll in ${Math.round(bootDelayMs / 1000)}s, ` +
      `then every ${Math.round(intervalMs / 60000)}m`,
  );
  return { started: true, stop: clearCronFailureAlertTimers };
};

/** Shape consumed by GET /api/watchdog/status → `status.cronFailureAlert`. */
const getCronFailureAlertStatus = () => ({
  enabled: kCronFailureAlertEnabled,
  intervalMinutes: Math.round(kCronFailureAlertIntervalMs / 60000),
  lastPollAt: state.lastPollAt,
  lastAlertAt: state.lastAlertAt,
  alertedJobs: Array.from(state.alertedByJobId.entries()).map(
    ([jobId, record]) => ({
      jobId,
      name: record?.name || jobId,
      lastAlertAt: new Date(toFiniteNumber(record?.alertedAtMs, 0)).toISOString(),
    }),
  ),
});

const resetCronFailureAlertState = () => {
  state = {
    watermarkByJobId: new Map(),
    alertedByJobId: new Map(),
    lastPollAt: null,
    lastAlertAt: null,
  };
  pollInFlight = false;
  clearCronFailureAlertTimers();
};

module.exports = {
  formatCronFailureMessage,
  loadCronFailureAlertState,
  saveCronFailureAlertState,
  runCronFailureAlertPoll,
  startCronFailureAlert,
  clearCronFailureAlertTimers,
  getCronFailureAlertStatus,
  resetCronFailureAlertState,
};
