const childProcess = require("child_process");

const modulePath = require.resolve("../../lib/server/commands");
const originalExec = childProcess.exec;

const loadCommandsModule = ({ execMock }) => {
  childProcess.exec = execMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

describe("server/commands", () => {
  afterEach(() => {
    childProcess.exec = originalExec;
    delete require.cache[modulePath];
  });

  it("attaches trimmed stdout and stderr to shellCmd errors", async () => {
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(new Error("boom"), ' {"ok":true} \n', " noisy stderr \n");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { shellCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    await expect(shellCmd("openclaw models list --all --json")).rejects.toMatchObject({
      message: "boom",
      stdout: '{"ok":true}',
      stderr: "noisy stderr",
      cmd: "openclaw models list --all --json",
    });
  });

  it("preserves timeout metadata on clawCmd failures", async () => {
    const timeoutError = Object.assign(new Error("Command failed"), {
      code: null,
      killed: true,
      signal: "SIGTERM",
    });
    const execMock = vi.fn((cmd, opts, callback) => {
      callback(timeoutError, "", "");
    });
    const { createCommands } = loadCommandsModule({ execMock });
    const { clawCmd } = createCommands({
      gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }),
    });

    const result = await clawCmd("nodes status --json", {
      quiet: true,
      timeoutMs: 1234,
    });

    expect(execMock).toHaveBeenCalledWith(
      "openclaw nodes status --json",
      expect.objectContaining({
        timeout: 1234,
        killSignal: "SIGTERM",
      }),
      expect.any(Function),
    );
    expect(result).toMatchObject({
      ok: false,
      stdout: "",
      stderr: "",
      code: null,
      killed: true,
      signal: "SIGTERM",
      timedOut: true,
    });
  });

  // The seam's contract: callers never interpret stderr/timedOut themselves —
  // `failureMessage` is the single, already-interpreted failure string.
  describe("failureMessage interpretation", () => {
    const load = (execMock) => {
      const { createCommands } = loadCommandsModule({ execMock });
      return createCommands({ gatewayEnv: () => ({ OPENCLAW_GATEWAY_TOKEN: "token" }) });
    };
    const timeoutError = (signal = "SIGTERM") =>
      Object.assign(new Error("Command failed"), { code: null, killed: true, signal });
    const exitError = (code) => Object.assign(new Error(`exit ${code}`), { code });

    it("success: failureMessage is null", async () => {
      const { clawCmd } = load(vi.fn((cmd, opts, cb) => cb(null, " hi \n", "")));
      const result = await clawCmd("status", { quiet: true });
      expect(result.ok).toBe(true);
      expect(result.failureMessage).toBeNull();
    });

    it("timeout: names the subcommand and the limit in seconds, never the args", async () => {
      const { clawCmd } = load(
        vi.fn((cmd, opts, cb) => cb(timeoutError(), "", "[warn] unrelated stderr noise")),
      );
      const result = await clawCmd("agent --message 'secret payload'", {
        quiet: true,
        timeoutMs: 300000,
      });
      expect(result.timedOut).toBe(true);
      expect(result.failureMessage).toBe("openclaw agent timed out after 300s");
      expect(result.failureMessage).not.toContain("secret");
    });

    it("timeout with a custom killSignal is still a timeout", async () => {
      const { clawCmd } = load(vi.fn((cmd, opts, cb) => cb(timeoutError("SIGKILL"), "", "")));
      const result = await clawCmd("doctor --fix --yes", {
        quiet: true,
        timeoutMs: 15000,
        killSignal: "SIGKILL",
      });
      expect(result.timedOut).toBe(true);
      expect(result.failureMessage).toBe("openclaw doctor timed out after 15s");
    });

    it("non-zero exit with stderr: failureMessage is the stderr", async () => {
      const { clawCmd } = load(
        vi.fn((cmd, opts, cb) => cb(exitError(1), "", " GatewayCredentialsRequiredError: nope \n")),
      );
      const result = await clawCmd("sessions --json", { quiet: true });
      expect(result.failureMessage).toBe("GatewayCredentialsRequiredError: nope");
    });

    it("non-zero exit without stderr: names subcommand and exit code", async () => {
      const { clawCmd } = load(vi.fn((cmd, opts, cb) => cb(exitError(3), "", "")));
      const result = await clawCmd("sessions --json", { quiet: true });
      expect(result.failureMessage).toBe("openclaw sessions exited with code 3");
    });

    it("external signal (not the timeout kill): reports the signal", async () => {
      const { clawCmd } = load(
        vi.fn((cmd, opts, cb) =>
          cb(Object.assign(new Error("term"), { killed: false, signal: "SIGKILL", code: null }), "", ""),
        ),
      );
      const result = await clawCmd("status", { quiet: true });
      expect(result.timedOut).toBeFalsy();
      expect(result.failureMessage).toBe("openclaw status was terminated by SIGKILL");
    });
  });

  describe("gogCmd gains the same contract", () => {
    const load = (execMock) => {
      const { createCommands } = loadCommandsModule({ execMock });
      return createCommands({ gatewayEnv: () => ({}) });
    };

    it("accepts timeoutMs and passes it to exec (default 15s)", async () => {
      const execMock = vi.fn((cmd, opts, cb) => cb(null, "ok", ""));
      const { gogCmd } = load(execMock);
      await gogCmd("gmail watch", { quiet: true, timeoutMs: 45000 });
      expect(execMock.mock.calls[0][1].timeout).toBe(45000);
      await gogCmd("gmail watch", { quiet: true });
      expect(execMock.mock.calls[1][1].timeout).toBe(15000);
    });

    it("reports timeouts with timedOut and failureMessage", async () => {
      const timeoutError = Object.assign(new Error("Command failed"), {
        code: null,
        killed: true,
        signal: "SIGTERM",
      });
      const { gogCmd } = load(vi.fn((cmd, opts, cb) => cb(timeoutError, "", "")));
      const result = await gogCmd("gmail watch", { quiet: true, timeoutMs: 45000 });
      expect(result.timedOut).toBe(true);
      expect(result.failureMessage).toBe("gog gmail timed out after 45s");
    });

    it("surfaces stderr on plain failure", async () => {
      const { gogCmd } = load(
        vi.fn((cmd, opts, cb) => cb(Object.assign(new Error("x"), { code: 1 }), "", "auth expired")),
      );
      const result = await gogCmd("gmail watch", { quiet: true });
      expect(result.failureMessage).toBe("auth expired");
    });
  });
});
