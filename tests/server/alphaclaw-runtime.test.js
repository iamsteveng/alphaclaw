const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ensureManagedAlphaclawRuntimeProject,
  getManagedAlphaclawCliPath,
  getManagedAlphaclawPackageJsonPath,
  getManagedAlphaclawRuntimeDir,
  installManagedAlphaclawRuntime,
  readBundledAlphaclawVersion,
  readManagedAlphaclawRuntimeVersion,
  syncManagedAlphaclawRuntimeWithBundled,
} = require("../../lib/server/alphaclaw-runtime");

describe("server/alphaclaw-runtime", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-runtime-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("builds the managed runtime directory under the AlphaClaw root", () => {
    expect(getManagedAlphaclawRuntimeDir({ rootDir: tmpDir })).toBe(
      path.join(tmpDir, ".alphaclaw-runtime"),
    );
  });

  it("seeds a minimal runtime package.json when needed", () => {
    const runtimeDir = getManagedAlphaclawRuntimeDir({ rootDir: tmpDir });

    const result = ensureManagedAlphaclawRuntimeProject({
      fsModule: fs,
      runtimeDir,
    });

    expect(result.runtimeDir).toBe(runtimeDir);
    expect(
      JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8")),
    ).toEqual({
      name: "alphaclaw-runtime",
      private: true,
    });
  });

  it("reads the managed runtime version from its package.json", () => {
    const runtimeDir = getManagedAlphaclawRuntimeDir({ rootDir: tmpDir });
    const pkgPath = getManagedAlphaclawPackageJsonPath({ runtimeDir });
    fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ name: "@chrysb/alphaclaw", version: "0.8.7" }),
    );

    expect(
      readManagedAlphaclawRuntimeVersion({
        fsModule: fs,
        runtimeDir,
      }),
    ).toBe("0.8.7");
  });

  it("reads the bundled AlphaClaw version from package.json", () => {
    const packageJsonPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "@chrysb/alphaclaw", version: "0.8.8" }),
    );

    expect(
      readBundledAlphaclawVersion({
        fsModule: fs,
        packageJsonPath,
      }),
    ).toBe("0.8.8");
  });

  it("installs into the managed runtime", () => {
    const runtimeDir = getManagedAlphaclawRuntimeDir({ rootDir: tmpDir });
    const execSyncImpl = vi.fn((command, options) => {
      const pkgPath = getManagedAlphaclawPackageJsonPath({ runtimeDir: options.cwd });
      fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
      fs.writeFileSync(
        pkgPath,
        JSON.stringify({ name: "@chrysb/alphaclaw", version: "0.8.7" }),
      );
    });

    const result = installManagedAlphaclawRuntime({
      execSyncImpl,
      fsModule: fs,
      runtimeDir,
      spec: "@chrysb/alphaclaw@0.8.7",
    });

    expect(result).toEqual({
      spec: "@chrysb/alphaclaw@0.8.7",
      version: "0.8.7",
    });
    expect(execSyncImpl).toHaveBeenCalledWith(
      "npm install '@chrysb/alphaclaw@0.8.7' --omit=dev --no-save --save=false --package-lock=false --prefer-online",
      {
        cwd: runtimeDir,
        stdio: "inherit",
        timeout: 180000,
      },
    );
    expect(fs.existsSync(getManagedAlphaclawCliPath({ runtimeDir }))).toBe(false);
  });

  it("seeds the managed runtime from the bundled AlphaClaw version when missing", () => {
    const runtimeDir = getManagedAlphaclawRuntimeDir({ rootDir: tmpDir });
    const packageJsonPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "@chrysb/alphaclaw", version: "0.8.9" }),
    );
    const execSyncImpl = vi.fn((command, options) => {
      const pkgPath = getManagedAlphaclawPackageJsonPath({ runtimeDir: options.cwd });
      fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
      fs.writeFileSync(
        pkgPath,
        JSON.stringify({ name: "@chrysb/alphaclaw", version: "0.8.9" }),
      );
    });

    const result = syncManagedAlphaclawRuntimeWithBundled({
      execSyncImpl,
      fsModule: fs,
      logger: { log: vi.fn() },
      runtimeDir,
      packageJsonPath,
    });

    expect(result).toEqual({
      checked: true,
      synced: true,
      bundledVersion: "0.8.9",
      runtimeVersion: "0.8.9",
    });
    expect(execSyncImpl).toHaveBeenCalledWith(
      "npm install '@chrysb/alphaclaw@0.8.9' --omit=dev --no-save --save=false --package-lock=false --prefer-online",
      {
        cwd: runtimeDir,
        stdio: "inherit",
        timeout: 180000,
      },
    );
  });

  it("does not downgrade a newer managed runtime during bundled sync", () => {
    const runtimeDir = getManagedAlphaclawRuntimeDir({ rootDir: tmpDir });
    const packageJsonPath = path.join(tmpDir, "package.json");
    const runtimePkgPath = getManagedAlphaclawPackageJsonPath({ runtimeDir });
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "@chrysb/alphaclaw", version: "0.8.8" }),
    );
    fs.mkdirSync(path.dirname(runtimePkgPath), { recursive: true });
    fs.writeFileSync(
      runtimePkgPath,
      JSON.stringify({ name: "@chrysb/alphaclaw", version: "0.8.9" }),
    );
    const execSyncImpl = vi.fn();

    const result = syncManagedAlphaclawRuntimeWithBundled({
      execSyncImpl,
      fsModule: fs,
      logger: { log: vi.fn() },
      runtimeDir,
      packageJsonPath,
    });

    expect(result).toEqual({
      checked: true,
      synced: false,
      bundledVersion: "0.8.8",
      runtimeVersion: "0.8.9",
    });
    expect(execSyncImpl).not.toHaveBeenCalled();
  });
});
