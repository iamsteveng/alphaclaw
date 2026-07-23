const { exec } = require("child_process");
const { OPENCLAW_DIR, GOG_KEYRING_PASSWORD } = require("./constants");

const createCommands = ({ gatewayEnv }) => {
  const shellCmd = (cmd, opts = {}) =>
    new Promise((resolve, reject) => {
      const {
        logStdout,
        timeoutMs = 60000,
        ...execOpts
      } = opts;
      const shouldLogStdout =
        typeof logStdout === "boolean" ? logStdout : !cmd.includes("--json");
      console.log(
        `[onboard] Running: ${cmd
          .replace(/ghp_[^\s"]+/g, "***")
          .replace(/github_pat_[^\s"]+/g, "***")
          .replace(/sk-[^\s"]+/g, "***")
          .slice(0, 200)}`,
      );
      exec(cmd, { timeout: timeoutMs, ...execOpts }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || "").trim();
          err.stderr = String(stderr || "").trim();
          err.cmd = cmd;
          console.error(
            `[onboard] Error: ${String(stderr || err.message || "").slice(0, 300)}`,
          );
          return reject(err);
        }
        if (shouldLogStdout && stdout.trim()) {
          console.log(`[onboard] ${stdout.trim().slice(0, 300)}`);
        }
        resolve(stdout.trim());
      });
    });

  // Failure interpretation is this module's job, not the caller's. Every CLI
  // result carries `failureMessage`: null on success, otherwise one string
  // that already distinguishes timeout / exit code / external signal / stderr.
  // Callers log or surface it verbatim — re-deriving meaning from stderr or
  // timedOut at a call site is how the /api/agent/message timeout bug (#56)
  // happened, and this seam exists so that class of bug can't recur.
  // Only the binary and the first token of the command appear in the message —
  // args can carry secrets (tokens, message payloads) and must not leak.
  const buildCliResult = ({ bin, cmd, err, stdout, stderr, timeoutMs, killSignal }) => {
    const result = {
      ok: !err,
      stdout: String(stdout || "").trim(),
      stderr: String(stderr || "").trim(),
      code: err?.code,
      failureMessage: null,
    };
    if (!err) return result;
    result.killed = Boolean(err.killed);
    result.signal = err.signal || null;
    result.timedOut = Boolean(err.killed && err.signal === killSignal);
    const subcommand = `${bin} ${String(cmd || "").trim().split(/\s+/)[0]}`;
    if (result.timedOut) {
      result.failureMessage = `${subcommand} timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else if (result.signal && !result.killed) {
      result.failureMessage = `${subcommand} was terminated by ${result.signal}`;
    } else {
      result.failureMessage =
        result.stderr || `${subcommand} exited with code ${result.code}`;
    }
    return result;
  };

  const clawCmd = (
    cmd,
    { quiet = false, timeoutMs = 15000, killSignal = "SIGTERM" } = {},
  ) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: openclaw ${cmd}`);
      exec(
        `openclaw ${cmd}`,
        {
          env: gatewayEnv(),
          timeout: timeoutMs,
          killSignal,
        },
        (err, stdout, stderr) => {
          const result = buildCliResult({
            bin: "openclaw",
            cmd,
            err,
            stdout,
            stderr,
            timeoutMs,
            killSignal,
          });
          if (!quiet && !result.ok) {
            console.log(`[alphaclaw] Error: ${result.failureMessage.slice(0, 200)}`);
          }
          resolve(result);
        },
      );
    });

  const gogCmd = (
    cmd,
    { quiet = false, timeoutMs = 15000, killSignal = "SIGTERM" } = {},
  ) =>
    new Promise((resolve) => {
      if (!quiet) console.log(`[alphaclaw] Running: gog ${cmd}`);
      exec(
        `gog ${cmd}`,
        {
          timeout: timeoutMs,
          killSignal,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: OPENCLAW_DIR,
            GOG_KEYRING_PASSWORD,
          },
        },
        (err, stdout, stderr) => {
          const result = buildCliResult({
            bin: "gog",
            cmd,
            err,
            stdout,
            stderr,
            timeoutMs,
            killSignal,
          });
          if (!quiet && !result.ok) {
            console.log(`[alphaclaw] gog error: ${result.failureMessage.slice(0, 200)}`);
          }
          resolve(result);
        },
      );
    });

  return { shellCmd, clawCmd, gogCmd };
};

module.exports = { createCommands };
