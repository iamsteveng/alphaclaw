const { runOnboardedBootSequence, ensureGbrainPersistentDbPath } = require("../../lib/server/startup");
const { kRootDir } = require("../../lib/server/constants");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

describe("server/startup", () => {
  it("syncs gateway proxy config with the resolved setup URL before startup", () => {
    const callOrder = [];
    const ensureManagedExecDefaults = vi.fn(() =>
      callOrder.push("ensureManagedExecDefaults"),
    );
    const ensureUsageTrackerPluginConfig = vi.fn(() =>
      callOrder.push("ensureUsageTrackerPluginConfig"),
    );
    const ensureAcpAgentConfig = vi.fn(() =>
      callOrder.push("ensureAcpAgentConfig"),
    );
    const ensureGatewayProviderConfig = vi.fn(() =>
      callOrder.push("ensureGatewayProviderConfig"),
    );
    const doSyncPromptFiles = vi.fn(() => callOrder.push("doSyncPromptFiles"));
    const reloadEnv = vi.fn(() => callOrder.push("reloadEnv"));
    const readEnvFile = vi.fn(() => {
      callOrder.push("readEnvFile");
      return [{ key: "OPENAI_API_KEY", value: "sk-test" }];
    });
    const syncChannelConfig = vi.fn(() => callOrder.push("syncChannelConfig"));
    const resolveSetupUrl = vi.fn(() => {
      callOrder.push("resolveSetupUrl");
      return "https://setup.example.com";
    });
    const ensureGatewayProxyConfig = vi.fn(() => callOrder.push("ensureGatewayProxyConfig"));
    const runOpenclawDoctorMigration = vi.fn(() => {
      callOrder.push("runOpenclawDoctorMigration");
      return { ran: false, ok: true, reason: "up-to-date" };
    });
    const startGateway = vi.fn(() => callOrder.push("startGateway"));
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
      getSettings: vi.fn(() => ({ notificationsEnabled: true })),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };
    const startCronFailureAlertScheduler = vi.fn(() =>
      callOrder.push("startCronFailureAlertScheduler"),
    );
    const cronService = { getBulkJobRuns: vi.fn() };
    const watchdogNotifier = { notify: vi.fn() };

    runOnboardedBootSequence({
      runOpenclawDoctorMigration,
      startCronFailureAlertScheduler,
      cronService,
      watchdogNotifier,
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      ensureAcpAgentConfig,
      ensureGatewayProviderConfig,
      doSyncPromptFiles,
      reloadEnv,
      syncChannelConfig,
      readEnvFile,
      ensureGatewayProxyConfig,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
    });

    expect(ensureGatewayProxyConfig).toHaveBeenCalledWith("https://setup.example.com");
    expect(callOrder).toEqual([
      "ensureManagedExecDefaults",
      "ensureUsageTrackerPluginConfig",
      "ensureAcpAgentConfig",
      "ensureGatewayProviderConfig",
      "doSyncPromptFiles",
      "reloadEnv",
      "readEnvFile",
      "syncChannelConfig",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "runOpenclawDoctorMigration",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
      "startCronFailureAlertScheduler",
    ]);
    expect(startCronFailureAlertScheduler).toHaveBeenCalledTimes(1);
    const alertDeps = startCronFailureAlertScheduler.mock.calls[0][0];
    expect(alertDeps.cronService).toBe(cronService);
    expect(alertDeps.notifier).toBe(watchdogNotifier);
    expect(alertDeps.isNotificationsEnabled()).toBe(true);
    watchdog.getSettings.mockReturnValue({ notificationsEnabled: false });
    expect(alertDeps.isNotificationsEnabled()).toBe(false);
  });

  it("does not let a failing cron-failure-alert scheduler break the boot sequence", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const gmailWatchService = { start: vi.fn() };
    const startCronFailureAlertScheduler = vi.fn(() => {
      throw new Error("scheduler exploded");
    });

    expect(() =>
      runOnboardedBootSequence({
        runOpenclawDoctorMigration: vi.fn(() => ({ ran: false, ok: true })),
        startCronFailureAlertScheduler,
        cronService: { getBulkJobRuns: vi.fn() },
        watchdogNotifier: { notify: vi.fn() },
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
        watchdog: { start: vi.fn(), getSettings: vi.fn(() => ({})) },
        gmailWatchService,
      }),
    ).not.toThrow();

    expect(gmailWatchService.start).toHaveBeenCalledTimes(1);
    expect(
      consoleSpy.mock.calls.some((call) =>
        String(call[0]).includes("Failed to schedule cron failure alerting"),
      ),
    ).toBe(true);
    consoleSpy.mockRestore();
  });
});

describe("ensureGbrainPersistentDbPath", () => {
  const configPath = path.join(kRootDir, ".gbrain", "config.json");
  const targetPath = path.join(kRootDir, ".gbrain", "brain.pglite");
  const tmpPath = targetPath + ".tmp";
  const sourcePath = "/root/.gbrain/brain.pglite";

  let existsSyncSpy, readFileSyncSpy, writeFileSyncSpy, cpSyncSpy, renameSyncSpy, rmSyncSpy, consoleSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    writeFileSyncSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    cpSyncSpy = vi.spyOn(fs, "cpSync").mockImplementation(() => {});
    renameSyncSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {});
    rmSyncSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("T5.3 — skips when config.json absent (fresh volume)", () => {
    ensureGbrainPersistentDbPath();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(cpSyncSpy).not.toHaveBeenCalled();
  });

  it("T5.2/T5.5 — no-op when database_path already under kRootDir (idempotent)", () => {
    const config = { engine: "pglite", database_path: targetPath };
    existsSyncSpy.mockImplementation((p) => p === configPath);
    readFileSyncSpy.mockReturnValue(JSON.stringify(config));

    ensureGbrainPersistentDbPath();

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(cpSyncSpy).not.toHaveBeenCalled();
  });

  it("T5.2 boundary — sibling path /data-sibling/ is not treated as inside kRootDir", () => {
    const siblingPath = kRootDir + "-sibling/.gbrain/brain.pglite";
    const config = { engine: "pglite", database_path: siblingPath };
    existsSyncSpy.mockImplementation((p) => {
      if (p === configPath) return true;
      if (p === targetPath) return false;
      if (p === siblingPath) return true;
      return false;
    });
    readFileSyncSpy.mockReturnValue(JSON.stringify(config));

    ensureGbrainPersistentDbPath();

    // Should migrate, not no-op
    expect(cpSyncSpy).toHaveBeenCalled();
    const written = JSON.parse(writeFileSyncSpy.mock.calls[0][1]);
    expect(written.database_path).toBe(targetPath);
  });

  it("T5.1 — atomically copies pglite and updates config when source exists and dest absent", () => {
    const config = { engine: "pglite", database_path: sourcePath };
    existsSyncSpy.mockImplementation((p) => {
      if (p === configPath) return true;
      if (p === targetPath) return false;
      if (p === tmpPath) return false;
      if (p === sourcePath) return true;
      return false;
    });
    readFileSyncSpy.mockReturnValue(JSON.stringify(config));

    ensureGbrainPersistentDbPath();

    expect(cpSyncSpy).toHaveBeenCalledWith(sourcePath, tmpPath, { recursive: true });
    expect(renameSyncSpy).toHaveBeenCalledWith(tmpPath, targetPath);
    const written = JSON.parse(writeFileSyncSpy.mock.calls[0][1]);
    expect(written.database_path).toBe(targetPath);
    expect(written.engine).toBe("pglite");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("gbrain database_path migrated"),
    );
  });

  it("T5.1 stale tmp — cleans up stale .tmp before copying", () => {
    const config = { engine: "pglite", database_path: sourcePath };
    existsSyncSpy.mockImplementation((p) => {
      if (p === configPath) return true;
      if (p === targetPath) return false;
      if (p === tmpPath) return true; // stale tmp exists
      if (p === sourcePath) return true;
      return false;
    });
    readFileSyncSpy.mockReturnValue(JSON.stringify(config));

    ensureGbrainPersistentDbPath();

    expect(rmSyncSpy).toHaveBeenCalledWith(tmpPath, { recursive: true, force: true });
    expect(cpSyncSpy).toHaveBeenCalled();
    expect(renameSyncSpy).toHaveBeenCalled();
  });

  it("T5.4 — updates config without copy when source is absent", () => {
    const config = { engine: "pglite", database_path: sourcePath };
    existsSyncSpy.mockImplementation((p) => p === configPath);
    readFileSyncSpy.mockReturnValue(JSON.stringify(config));

    ensureGbrainPersistentDbPath();

    expect(cpSyncSpy).not.toHaveBeenCalled();
    const written = JSON.parse(writeFileSyncSpy.mock.calls[0][1]);
    expect(written.database_path).toBe(targetPath);
    expect(written.engine).toBe("pglite");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("source absent"),
    );
  });

  it("T5.6 — skips copy when destination already exists, still updates config", () => {
    const config = { engine: "pglite", database_path: sourcePath };
    existsSyncSpy.mockImplementation((p) => {
      if (p === configPath) return true;
      if (p === targetPath) return true;
      if (p === sourcePath) return true;
      return false;
    });
    readFileSyncSpy.mockReturnValue(JSON.stringify(config));

    ensureGbrainPersistentDbPath();

    expect(cpSyncSpy).not.toHaveBeenCalled();
    const written = JSON.parse(writeFileSyncSpy.mock.calls[0][1]);
    expect(written.database_path).toBe(targetPath);
    expect(written.engine).toBe("pglite");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("destination already exists, skipped copy"),
    );
  });

  it("non-fatal — catches and logs error without throwing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockImplementation(() => { throw new Error("disk error"); });

    expect(() => ensureGbrainPersistentDbPath()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("migration failed"),
      "disk error",
    );
  });
});

describe("ensureGbrainEmbeddingConfig", () => {
  const configPath = path.join(kRootDir, ".gbrain", "config.json");
  const modulePath = require.resolve("../../lib/server/startup");
  const originalExecSync = childProcess.execSync;
  const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const originalLlamaServerBaseUrl = process.env.LLAMA_SERVER_BASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  let existsSyncSpy, readFileSyncSpy, consoleLogSpy, consoleErrorSpy, execSyncMock, loadedEnsureGbrainEmbeddingConfig;

  const loadModule = () => {
    delete require.cache[modulePath];
    return require(modulePath).ensureGbrainEmbeddingConfig;
  };

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    readFileSyncSpy = vi.spyOn(fs, "readFileSync");
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    execSyncMock = vi.fn(() => "");
    childProcess.execSync = execSyncMock;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.LLAMA_SERVER_BASE_URL;
    delete process.env.DATABASE_URL;
    loadedEnsureGbrainEmbeddingConfig = loadModule();
  });

  afterEach(() => {
    childProcess.execSync = originalExecSync;
    if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
    if (originalLlamaServerBaseUrl === undefined) delete process.env.LLAMA_SERVER_BASE_URL;
    else process.env.LLAMA_SERVER_BASE_URL = originalLlamaServerBaseUrl;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    delete require.cache[modulePath];
  });

  it("no-op when neither OLLAMA_BASE_URL nor LLAMA_SERVER_BASE_URL is set", () => {
    loadedEnsureGbrainEmbeddingConfig();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(existsSyncSpy).not.toHaveBeenCalled();
  });

  it("LLAMA_SERVER_BASE_URL alone — points at manual setup, does not auto-wire", () => {
    process.env.LLAMA_SERVER_BASE_URL = "http://llama-server:8080";

    loadedEnsureGbrainEmbeddingConfig();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("run `gbrain init --embedding-model llama-server:"),
    );
  });

  it("OLLAMA_BASE_URL set, config.json absent, DATABASE_URL set — wires postgres engine", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    process.env.DATABASE_URL = "postgresql://postgres:postgres@postgres:5432/gbrain";

    loadedEnsureGbrainEmbeddingConfig();

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const [cmd] = execSyncMock.mock.calls[0];
    expect(cmd).toContain("gbrain init --supabase --non-interactive");
    expect(cmd).toContain("--embedding-model ollama:nomic-embed-text");
    expect(cmd).toContain("--embedding-dimensions 768");
  });

  it("OLLAMA_BASE_URL set, config.json absent, no DATABASE_URL — wires pglite engine", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";

    loadedEnsureGbrainEmbeddingConfig();

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const [cmd] = execSyncMock.mock.calls[0];
    expect(cmd).toContain("gbrain init --pglite --non-interactive");
  });

  it("OLLAMA_BASE_URL set, config already pinned to ollama:nomic-embed-text — no-op", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    existsSyncSpy.mockImplementation((p) => p === configPath);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ engine: "postgres", embedding_model: "ollama:nomic-embed-text" }));

    loadedEnsureGbrainEmbeddingConfig();

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("embedding config is current"),
    );
  });

  it("OLLAMA_BASE_URL set, config pinned to a different provider — re-wires using existing engine", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    existsSyncSpy.mockImplementation((p) => p === configPath);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ engine: "pglite", embedding_model: "zeroentropyai:zembed-1" }));

    loadedEnsureGbrainEmbeddingConfig();

    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const [cmd] = execSyncMock.mock.calls[0];
    expect(cmd).toContain("gbrain init --pglite --non-interactive");
  });

  it("non-fatal — execSync failure is caught and logged, does not throw", () => {
    process.env.OLLAMA_BASE_URL = "http://ollama:11434";
    execSyncMock.mockImplementation(() => { throw new Error("gbrain init failed"); });

    expect(() => loadedEnsureGbrainEmbeddingConfig()).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("embedding provider wire-up failed"),
      "gbrain init failed",
    );
  });
});

describe("runOpenclawUpgradeDoctor", () => {
  const { runOpenclawUpgradeDoctor } = require("../../lib/server/startup");

  const createLogger = () => {
    const lines = [];
    return {
      lines,
      log: (line) => lines.push(String(line)),
      error: (line) => lines.push(String(line)),
    };
  };

  const createFsStub = ({ marker = null } = {}) => {
    const writes = [];
    return {
      writes,
      readFileSync: vi.fn(() => {
        if (marker === null) {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }
        return marker;
      }),
      writeFileSync: vi.fn((filePath, contents) => writes.push([filePath, contents])),
      mkdirSync: vi.fn(() => {}),
    };
  };

  it("runs doctor and writes the marker when the version differs", () => {
    const fsStub = createFsStub({ marker: "2026.7.9\n" });
    const execSyncImpl = vi.fn(() => "line one\nAll checks passed\n");
    const logger = createLogger();

    const result = runOpenclawUpgradeDoctor({
      fsModule: fsStub,
      execSyncImpl,
      markerPath: "/data/.alphaclaw/openclaw-doctor-version",
      openclawVersion: "2026.9.1",
      env: { HOME: "/data" },
      logger,
    });

    expect(result).toMatchObject({ ran: true, ok: true, code: 0, version: "2026.9.1" });
    expect(execSyncImpl).toHaveBeenCalledTimes(1);
    const [cmd, opts] = execSyncImpl.mock.calls[0];
    expect(cmd).toBe("openclaw doctor --fix --non-interactive");
    expect(opts.env).toEqual({ HOME: "/data" });
    expect(opts.timeout).toBeGreaterThanOrEqual(60000);
    expect(fsStub.writes).toEqual([
      [
        "/data/.alphaclaw/openclaw-doctor-version",
        `${JSON.stringify({ version: "2026.9.1", status: "ok", failures: 0 }, null, 2)}\n`,
      ],
    ]);
    expect(logger.lines.join("\n")).toContain("openclaw doctor --fix exited 0");
  });

  it("runs doctor when no marker exists yet (fresh volume)", () => {
    const fsStub = createFsStub({ marker: null });
    const execSyncImpl = vi.fn(() => "ok");

    const result = runOpenclawUpgradeDoctor({
      fsModule: fsStub,
      execSyncImpl,
      markerPath: "/data/.alphaclaw/openclaw-doctor-version",
      openclawVersion: "2026.9.1",
      env: {},
      logger: createLogger(),
    });

    expect(result.ran).toBe(true);
    expect(fsStub.writes.length).toBe(1);
  });

  it("skips doctor when the marker already matches the installed version", () => {
    const fsStub = createFsStub({ marker: "2026.9.1\n" });
    const execSyncImpl = vi.fn(() => "");

    const result = runOpenclawUpgradeDoctor({
      fsModule: fsStub,
      execSyncImpl,
      markerPath: "/data/.alphaclaw/openclaw-doctor-version",
      openclawVersion: "2026.9.1",
      env: {},
      logger: createLogger(),
    });

    expect(result).toEqual({ ran: false, ok: true, reason: "up-to-date", version: "2026.9.1" });
    expect(execSyncImpl).not.toHaveBeenCalled();
    expect(fsStub.writes).toEqual([]);
  });

  it("logs and continues without writing the marker when doctor exits nonzero", () => {
    const fsStub = createFsStub({ marker: null });
    const failure = Object.assign(new Error("doctor failed"), {
      status: 1,
      stdout: "checking...\n",
      stderr: "retained conflicting legacy JSON\n",
    });
    const execSyncImpl = vi.fn(() => {
      throw failure;
    });
    const logger = createLogger();

    const result = runOpenclawUpgradeDoctor({
      fsModule: fsStub,
      execSyncImpl,
      markerPath: "/data/.alphaclaw/openclaw-doctor-version",
      openclawVersion: "2026.9.1",
      env: {},
      logger,
    });

    expect(result).toMatchObject({ ran: true, ok: false, code: 1, failures: 1 });
    // The marker is written on failure too, but only to carry the retry counter
    // — its `status` keeps the version from counting as migrated.
    expect(fsStub.writes.length).toBe(1);
    const [markerPath, contents] = fsStub.writes[0];
    expect(markerPath).toBe("/data/.alphaclaw/openclaw-doctor-version");
    expect(JSON.parse(contents)).toMatchObject({
      version: "2026.9.1",
      status: "failed",
      failures: 1,
    });
    expect(JSON.parse(contents).lastError).toContain("retained conflicting legacy JSON");
    const logged = logger.lines.join("\n");
    expect(logged).toContain("openclaw doctor --fix exited 1");
    expect(logged).toContain("retained conflicting legacy JSON");
    expect(logged).toContain("attempt 1/3");
  });

  it("skips when the installed OpenClaw version cannot be resolved", () => {
    const fsStub = createFsStub({ marker: null });
    const execSyncImpl = vi.fn(() => "");

    const result = runOpenclawUpgradeDoctor({
      fsModule: fsStub,
      execSyncImpl,
      openclawVersion: null,
      env: {},
      logger: createLogger(),
    });

    expect(result).toMatchObject({ ran: false, reason: "unknown-version" });
    expect(execSyncImpl).not.toHaveBeenCalled();
  });

  it("never throws when the marker write fails", () => {
    const fsStub = createFsStub({ marker: null });
    fsStub.writeFileSync = vi.fn(() => {
      throw new Error("read-only fs");
    });
    const execSyncImpl = vi.fn(() => "ok");
    const logger = createLogger();

    const result = runOpenclawUpgradeDoctor({
      fsModule: fsStub,
      execSyncImpl,
      openclawVersion: "2026.9.1",
      env: {},
      logger,
    });

    expect(result).toMatchObject({ ran: false, reason: "error" });
    expect(logger.lines.join("\n")).toContain("non-fatal");
  });
});
describe("runOpenclawUpgradeDoctor failure cap", () => {
  const { runOpenclawUpgradeDoctor } = require("../../lib/server/startup");

  let alphaclawDir;
  let markerPath;

  beforeEach(() => {
    alphaclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-doctor-"));
    markerPath = path.join(alphaclawDir, "openclaw-doctor-version");
  });

  afterEach(() => {
    fs.rmSync(alphaclawDir, { recursive: true, force: true });
  });

  const createLogger = () => {
    const lines = [];
    return {
      lines,
      log: (line) => lines.push(String(line)),
      error: (line) => lines.push(String(line)),
    };
  };

  const failingExec = (message = "retained conflicting legacy JSON\n") =>
    vi.fn(() => {
      throw Object.assign(new Error("doctor failed"), {
        status: 1,
        stdout: "checking...\n",
        stderr: message,
      });
    });

  const boot = ({ execSyncImpl, openclawVersion = "2026.9.1", logger }) =>
    runOpenclawUpgradeDoctor({
      execSyncImpl,
      markerPath,
      openclawVersion,
      env: {},
      logger: logger || createLogger(),
    });

  const readMarker = () => JSON.parse(fs.readFileSync(markerPath, "utf8"));

  it("increments the failure counter on each failed boot", () => {
    const execSyncImpl = failingExec();

    expect(boot({ execSyncImpl })).toMatchObject({ ran: true, ok: false, failures: 1 });
    expect(readMarker()).toMatchObject({ version: "2026.9.1", status: "failed", failures: 1 });

    expect(boot({ execSyncImpl })).toMatchObject({ ran: true, ok: false, failures: 2 });
    expect(readMarker()).toMatchObject({ status: "failed", failures: 2 });

    expect(execSyncImpl).toHaveBeenCalledTimes(2);
  });

  it("caps at three failed attempts and stops running doctor", () => {
    const execSyncImpl = failingExec();

    boot({ execSyncImpl });
    boot({ execSyncImpl });
    const third = boot({ execSyncImpl });

    expect(third).toMatchObject({ ran: true, ok: false, failures: 3 });
    expect(readMarker()).toMatchObject({ status: "failed", failures: 3 });
    expect(execSyncImpl).toHaveBeenCalledTimes(3);

    const logger = createLogger();
    const fourth = boot({ execSyncImpl, logger });

    expect(fourth).toMatchObject({
      ran: false,
      ok: false,
      reason: "failure-cap",
      version: "2026.9.1",
      failures: 3,
    });
    // Still three: the capped boot never shells out.
    expect(execSyncImpl).toHaveBeenCalledTimes(3);
    const logged = logger.lines.join("\n");
    expect(logged).toContain("openclaw doctor migration skipped: 3 failed attempts for 2026.9.1");
    expect(logged).toContain("openclaw doctor --fix");
    expect(logged).toContain(markerPath);
  });

  it("retries a newly installed version even after the previous one was capped", () => {
    const failing = failingExec();
    boot({ execSyncImpl: failing });
    boot({ execSyncImpl: failing });
    boot({ execSyncImpl: failing });
    expect(readMarker()).toMatchObject({ version: "2026.9.1", failures: 3 });

    const nextVersion = vi.fn(() => "All checks passed\n");
    const result = boot({ execSyncImpl: nextVersion, openclawVersion: "2026.10.0" });

    expect(nextVersion).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ran: true, ok: true, reason: "repaired" });
    expect(readMarker()).toEqual({ version: "2026.10.0", status: "ok", failures: 0 });
  });

  it("resets the failure count when doctor finally succeeds", () => {
    boot({ execSyncImpl: failingExec() });
    boot({ execSyncImpl: failingExec() });
    expect(readMarker()).toMatchObject({ status: "failed", failures: 2 });

    const passing = vi.fn(() => "All checks passed\n");
    expect(boot({ execSyncImpl: passing })).toMatchObject({ ran: true, ok: true, failures: 0 });
    expect(readMarker()).toEqual({ version: "2026.9.1", status: "ok", failures: 0 });

    // And the next boot short-circuits on the ok marker.
    const afterSuccess = vi.fn(() => "");
    expect(boot({ execSyncImpl: afterSuccess })).toMatchObject({ reason: "up-to-date" });
    expect(afterSuccess).not.toHaveBeenCalled();
  });

  it("honours a legacy plain-text marker as a completed migration", () => {
    fs.writeFileSync(markerPath, "2026.9.1\n", "utf8");
    const execSyncImpl = vi.fn(() => "");

    const result = boot({ execSyncImpl });

    expect(result).toEqual({ ran: false, ok: true, reason: "up-to-date", version: "2026.9.1" });
    expect(execSyncImpl).not.toHaveBeenCalled();
    // Untouched — a legacy marker is not rewritten just to change format.
    expect(fs.readFileSync(markerPath, "utf8")).toBe("2026.9.1\n");
  });

  it("re-runs doctor when a legacy plain-text marker names an older version", () => {
    fs.writeFileSync(markerPath, "2026.7.9\n", "utf8");
    const execSyncImpl = vi.fn(() => "ok");

    expect(boot({ execSyncImpl })).toMatchObject({ ran: true, ok: true, reason: "repaired" });
    expect(execSyncImpl).toHaveBeenCalledTimes(1);
    expect(readMarker()).toEqual({ version: "2026.9.1", status: "ok", failures: 0 });
  });
});
