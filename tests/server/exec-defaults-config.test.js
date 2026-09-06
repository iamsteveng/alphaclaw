const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureManagedExecDefaults,
  resolveInstalledOpenclawVersion,
  usesSqliteExecApprovals,
  isAlphaclawManagedExecApprovalsFile,
} = require("../../lib/server/exec-defaults-config");

// Pre-2.0 OpenClaw: exec approvals live in exec-approvals.json.
const kLegacyOpenclawVersion = "2026.7.9";
// 2026.8.1+ moved exec approvals into SQLite and treats the JSON file as a
// blocking legacy store.
const kSqliteOpenclawVersion = "2026.9.1";

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-exec-defaults-test-"));

describe("server/exec-defaults-config", () => {
  it("fills missing managed exec defaults for openclaw.json and exec-approvals.json", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          tools: {
            profile: "full",
          },
          channels: {
            telegram: { enabled: true },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kLegacyOpenclawVersion,
    });

    expect(result).toEqual({
      changed: true,
      openclawChanged: true,
      approvalsChanged: true,
      approvalsSkipped: false,
      approvalsRetired: false,
    });

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(openclawConfig.tools).toEqual({
      profile: "full",
      exec: {
        security: "full",
        strictInlineEval: false,
      },
    });
    expect(openclawConfig.channels.telegram).toEqual({ enabled: true });

    const approvals = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "exec-approvals.json"), "utf8"),
    );
    expect(approvals).toEqual({
      version: 1,
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
      },
      agents: {},
    });
  });

  it("preserves existing exec settings when they are already configured", () => {
    const openclawDir = createTempOpenclawDir();
    const openclawPath = path.join(openclawDir, "openclaw.json");
    const approvalsPath = path.join(openclawDir, "exec-approvals.json");
    const openclawContent = JSON.stringify(
      {
        tools: {
          profile: "full",
          exec: {
            host: "node",
            node: "mac-1",
            security: "allowlist",
            ask: "always",
            strictInlineEval: true,
          },
        },
      },
      null,
      2,
    );
    const approvalsContent =
      JSON.stringify(
        {
          version: 1,
          defaults: {
            security: "allowlist",
            ask: "always",
            askFallback: "deny",
          },
          agents: {
            main: {
              security: "allowlist",
            },
          },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(openclawPath, openclawContent, "utf8");
    fs.writeFileSync(approvalsPath, approvalsContent, "utf8");

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kLegacyOpenclawVersion,
    });

    expect(result).toEqual({
      changed: false,
      openclawChanged: false,
      approvalsChanged: false,
      approvalsSkipped: false,
      approvalsRetired: false,
    });
    expect(fs.readFileSync(openclawPath, "utf8")).toBe(openclawContent);
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsContent);
  });

  it("does not add or change openclaw exec subkeys when tools.exec already exists", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify(
        {
          tools: {
            profile: "full",
            exec: {
              host: "gateway",
              ask: "off",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kLegacyOpenclawVersion,
    });

    expect(result).toEqual({
      changed: true,
      openclawChanged: false,
      approvalsChanged: true,
      approvalsSkipped: false,
      approvalsRetired: false,
    });

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(openclawConfig.tools.exec).toEqual({
      host: "gateway",
      ask: "off",
    });
  });

  it("does not add or change exec approvals defaults when defaults is a non-empty object", () => {
    const openclawDir = createTempOpenclawDir();
    const openclawPath = path.join(openclawDir, "openclaw.json");
    const approvalsPath = path.join(openclawDir, "exec-approvals.json");
    const openclawContent = JSON.stringify(
      {
        tools: {
          profile: "full",
          exec: {
            host: "gateway",
          },
        },
      },
      null,
      2,
    );
    const approvalsContent =
      JSON.stringify(
        {
          socket: {
            path: "/data/.openclaw/exec-approvals.sock",
            token: "",
          },
          defaults: {
            ask: "always",
          },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(openclawPath, openclawContent, "utf8");
    fs.writeFileSync(approvalsPath, approvalsContent, "utf8");

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kLegacyOpenclawVersion,
    });

    expect(result).toEqual({
      changed: false,
      openclawChanged: false,
      approvalsChanged: false,
      approvalsSkipped: false,
      approvalsRetired: false,
    });
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsContent);
  });
});

describe("server/exec-defaults-config version gate", () => {
  const silentLogger = { log: () => {} };

  it("usesSqliteExecApprovals compares calendar versions numerically", () => {
    expect(usesSqliteExecApprovals("2026.8.1")).toBe(true);
    expect(usesSqliteExecApprovals("2026.9.1")).toBe(true);
    expect(usesSqliteExecApprovals("2026.10.0")).toBe(true);
    expect(usesSqliteExecApprovals("2027.1.0")).toBe(true);
    expect(usesSqliteExecApprovals("2026.8.0")).toBe(false);
    expect(usesSqliteExecApprovals("2026.7.9")).toBe(false);
    // 2026.9.1 > 2026.8.1 only under numeric comparison; a string compare
    // would order "2026.10.0" before "2026.8.1".
    expect(usesSqliteExecApprovals("2026.10.0")).toBe(true);
    // Unknown version keeps the pre-2.0 behaviour.
    expect(usesSqliteExecApprovals(null)).toBe(false);
    expect(usesSqliteExecApprovals("")).toBe(false);
  });

  it("resolveInstalledOpenclawVersion reads the installed openclaw package version", () => {
    const version = resolveInstalledOpenclawVersion();
    expect(version).toMatch(/^\d{4}\.\d+\.\d+/);
  });

  it("pre-2.0 — writes exec-approvals.json and legacy tools.exec.security", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full" } }, null, 2),
      "utf8",
    );

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kLegacyOpenclawVersion,
      logger: silentLogger,
    });

    expect(result.approvalsSkipped).toBe(false);
    expect(result.approvalsChanged).toBe(true);
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(true);

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(openclawConfig.tools.exec).toEqual({
      security: "full",
      strictInlineEval: false,
    });
  });

  it("2.0+ — never writes exec-approvals.json and uses tools.exec.mode", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full" } }, null, 2),
      "utf8",
    );
    const logs = [];

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kSqliteOpenclawVersion,
      logger: { log: (line) => logs.push(line) },
    });

    expect(result).toEqual({
      changed: true,
      openclawChanged: true,
      approvalsChanged: false,
      approvalsSkipped: true,
      approvalsRetired: false,
    });
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(false);
    expect(logs.join("\n")).toContain("skipping legacy exec-approvals.json");

    const openclawConfig = JSON.parse(
      fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
    );
    expect(openclawConfig.tools.exec).toEqual({
      mode: "full",
      strictInlineEval: false,
    });
  });

  it("2.0+ — archives an AlphaClaw-managed legacy exec-approvals.json", () => {
    const openclawDir = createTempOpenclawDir();
    const approvalsPath = path.join(openclawDir, "exec-approvals.json");
    // Exactly what pre-2.0 AlphaClaw wrote (plus the socket block OpenClaw added).
    const approvalsContent =
      JSON.stringify(
        {
          version: 1,
          socket: { path: "/data/.openclaw/exec-approvals.sock", token: "tok" },
          defaults: { security: "full", ask: "off", askFallback: "full" },
          agents: {},
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full", exec: { mode: "full" } } }, null, 2),
      "utf8",
    );
    fs.writeFileSync(approvalsPath, approvalsContent, "utf8");

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kSqliteOpenclawVersion,
      logger: silentLogger,
    });

    expect(result).toEqual({
      changed: true,
      openclawChanged: false,
      approvalsChanged: false,
      approvalsSkipped: true,
      approvalsRetired: true,
    });
    expect(fs.existsSync(approvalsPath)).toBe(false);
    const archived = fs
      .readdirSync(openclawDir)
      .filter((name) => name.startsWith("exec-approvals.json.alphaclaw-retired-"));
    expect(archived.length).toBe(1);
    expect(fs.readFileSync(path.join(openclawDir, archived[0]), "utf8")).toBe(approvalsContent);
  });

  it("2.0+ — leaves an operator-edited exec-approvals.json in place", () => {
    const openclawDir = createTempOpenclawDir();
    const approvalsPath = path.join(openclawDir, "exec-approvals.json");
    const approvalsContent =
      JSON.stringify(
        {
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss", askFallback: "deny" },
          agents: { main: { allowlist: [{ pattern: "/usr/bin/uptime" }] } },
        },
        null,
        2,
      ) + "\n";
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full", exec: { mode: "full" } } }, null, 2),
      "utf8",
    );
    fs.writeFileSync(approvalsPath, approvalsContent, "utf8");

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: kSqliteOpenclawVersion,
      logger: silentLogger,
    });

    expect(result.approvalsRetired).toBe(false);
    expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsContent);
  });

  it("isAlphaclawManagedExecApprovalsFile only accepts the managed shape", () => {
    expect(isAlphaclawManagedExecApprovalsFile({ version: 1 })).toBe(true);
    expect(
      isAlphaclawManagedExecApprovalsFile({
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "full" },
        agents: {},
      }),
    ).toBe(true);
    expect(
      isAlphaclawManagedExecApprovalsFile({ defaults: { security: "deny" } }),
    ).toBe(false);
    expect(
      isAlphaclawManagedExecApprovalsFile({ agents: { main: { security: "full" } } }),
    ).toBe(false);
    expect(isAlphaclawManagedExecApprovalsFile({ version: 2 })).toBe(false);
    expect(isAlphaclawManagedExecApprovalsFile({ pendingApprovals: [] })).toBe(false);
    expect(isAlphaclawManagedExecApprovalsFile(null)).toBe(false);
  });

  it("unknown version — falls back to the pre-2.0 path", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ tools: { profile: "full" } }, null, 2),
      "utf8",
    );

    const result = ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir,
      openclawVersion: null,
      logger: silentLogger,
    });

    expect(result.approvalsSkipped).toBe(false);
    expect(fs.existsSync(path.join(openclawDir, "exec-approvals.json"))).toBe(true);
  });
});
