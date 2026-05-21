const {
  shouldSkipSystemCronInstall,
  resolveGitAskPassPath,
  resolveGitShimPath,
  resolveRealGitPath,
  shouldRefreshHourlyGitSyncScript,
} = require("../../lib/cli/git-runtime");

describe("cli/git runtime helpers", () => {
  it("honors the system cron install opt-out flag", () => {
    expect(
      shouldSkipSystemCronInstall({
        env: { ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true" },
      }),
    ).toBe(true);
    expect(
      shouldSkipSystemCronInstall({
        env: { ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "0" },
      }),
    ).toBe(false);
  });

  it("resolves git helper paths from runtime environment", () => {
    expect(
      resolveGitAskPassPath({
        env: { TMPDIR: "/runtime/tmp" },
        tmpDir: "/fallback/tmp",
      }),
    ).toBe("/runtime/tmp/alphaclaw-git-askpass.sh");
    expect(
      resolveGitAskPassPath({
        env: { ALPHACLAW_GIT_ASKPASS_PATH: "/state/git-askpass" },
        tmpDir: "/fallback/tmp",
      }),
    ).toBe("/state/git-askpass");
    expect(
      resolveGitShimPath({
        env: { ALPHACLAW_GIT_SHIM_PATH: "/state/bin/git" },
      }),
    ).toBe("/state/bin/git");
    expect(resolveGitShimPath({ env: {} })).toBe("/usr/local/bin/git");
  });

  it("resolves a real git path while skipping the installed shim", () => {
    const resolvedPath = resolveRealGitPath({
      shimPath: "/usr/local/bin/git",
      execSyncImpl: () => ["/usr/local/bin/git", "/bin/git"].join("\n"),
      fsModule: {
        constants: { X_OK: 1 },
        accessSync(targetPath) {
          if (targetPath !== "/bin/git") {
            throw new Error("not executable");
          }
        },
      },
    });

    expect(resolvedPath).toBe("/bin/git");
  });

  it("prefers the explicit hinted path when it is executable", () => {
    const resolvedPath = resolveRealGitPath({
      shimPath: "/usr/local/bin/git",
      hintedPath: "/custom/git",
      execSyncImpl: () => "",
      fsModule: {
        constants: { X_OK: 1 },
        accessSync(targetPath) {
          if (targetPath !== "/custom/git") {
            throw new Error("not executable");
          }
        },
      },
    });

    expect(resolvedPath).toBe("/custom/git");
  });

  it("refreshes the managed hourly sync script when it changes or is missing", () => {
    expect(
      shouldRefreshHourlyGitSyncScript({
        packagedSyncScript: "echo managed script\n",
        installedSyncScript: "",
      }),
    ).toBe(true);

    expect(
      shouldRefreshHourlyGitSyncScript({
        packagedSyncScript: "echo managed script v2\n",
        installedSyncScript: "echo managed script v1\n",
      }),
    ).toBe(true);

    expect(
      shouldRefreshHourlyGitSyncScript({
        packagedSyncScript: "echo managed script\n",
        installedSyncScript: "echo managed script\n",
      }),
    ).toBe(false);
  });
});
