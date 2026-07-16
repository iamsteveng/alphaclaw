const { runOnboardedBootSequence, ensureGbrainPersistentDbPath } = require("../../lib/server/startup");
const { kRootDir } = require("../../lib/server/constants");
const fs = require("fs");
const path = require("path");
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
    const ensureGlmProviderConfig = vi.fn(() =>
      callOrder.push("ensureGlmProviderConfig"),
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
    const startGateway = vi.fn(() => callOrder.push("startGateway"));
    const watchdog = {
      start: vi.fn(() => callOrder.push("watchdog.start")),
    };
    const gmailWatchService = {
      start: vi.fn(() => callOrder.push("gmailWatchService.start")),
    };

    runOnboardedBootSequence({
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      ensureAcpAgentConfig,
      ensureGlmProviderConfig,
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
      "ensureGlmProviderConfig",
      "doSyncPromptFiles",
      "reloadEnv",
      "readEnvFile",
      "syncChannelConfig",
      "resolveSetupUrl",
      "ensureGatewayProxyConfig",
      "startGateway",
      "watchdog.start",
      "gmailWatchService.start",
    ]);
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
