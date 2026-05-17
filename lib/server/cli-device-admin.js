const fs = require("fs");
const { OPENCLAW_DIR } = require("./constants");
const { buildManagedPaths } = require("./internal-files-migration");
const { parseJsonObjectFromNoisyOutput } = require("./utils/json");

const kAdminScope = "operator.admin";
const kDeviceApprovalCallerScopes = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.talk.secrets",
];
const kPollIntervalMs = 500;
const kMaxPollAttempts = 40; // 20 seconds

let deviceBootstrapModulePromise = null;
const loadDeviceBootstrapModule = () => {
  deviceBootstrapModulePromise ||= import("openclaw/plugin-sdk/device-bootstrap");
  return deviceBootstrapModulePromise;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const quoteArg = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const getPairedCliDevice = (parsed) => {
  const devices = Array.isArray(parsed?.paired) ? parsed.paired : [];
  return devices.find((d) => {
    const clientId = String(d.clientId || "").toLowerCase();
    const clientMode = String(d.clientMode || "").toLowerCase();
    return clientId === "cli" || clientMode === "cli";
  }) ?? null;
};

// Checks if the stored CLI device has operator.admin scope.
// If not, revokes it, triggers reconnection, and re-approves with admin scope via the SDK
// (filesystem-level write that bypasses the gateway scope restriction).
const ensureCliDeviceHasAdminScope = async ({ clawCmd, openclawDir = OPENCLAW_DIR } = {}) => {
  try {
    const listResult = await clawCmd("devices list --json", { quiet: true, timeoutMs: 8000 });
    if (!listResult?.ok) return;

    const parsed = parseJsonObjectFromNoisyOutput(listResult.stdout);
    const cliDevice = getPairedCliDevice(parsed);

    if (!cliDevice) return; // No paired CLI device yet; pairings auto-approve handles first pairing

    const approvedScopes = Array.isArray(cliDevice.approvedScopes)
      ? cliDevice.approvedScopes
      : Array.isArray(cliDevice.scopes)
        ? cliDevice.scopes
        : [];

    if (approvedScopes.includes(kAdminScope)) return; // Already provisioned correctly

    console.log("[alphaclaw] CLI device is missing operator.admin scope; re-provisioning...");

    const deviceId = String(cliDevice.deviceId || cliDevice.id || "").trim();
    if (!deviceId) return;

    // Clear auto-approve marker so the pairings route can re-approve if needed.
    const paths = buildManagedPaths({ openclawDir });
    try { fs.unlinkSync(paths.cliDeviceAutoApprovedPath); } catch {}

    // Revoke the device — this only requires operator.pairing scope, which the current token has.
    const removeResult = await clawCmd(`devices remove ${quoteArg(deviceId)}`, {
      quiet: true,
      timeoutMs: 10000,
    });
    if (!removeResult?.ok) {
      console.warn(`[alphaclaw] Could not revoke CLI device: ${removeResult?.stderr?.slice(0, 200)}`);
      return;
    }

    // Trigger a CLI connection — since the device is now revoked it will create a pending
    // "not-paired" pairing request, then block waiting for approval.
    const triggerPromise = clawCmd("cron list --json", { quiet: true, timeoutMs: 30000 }).catch(() => {});

    // Poll the device pairing store (filesystem read, no gateway scope needed) until the
    // pending CLI request appears, then approve it with full admin scope.
    let approved = false;
    const mod = await loadDeviceBootstrapModule();
    for (let i = 0; i < kMaxPollAttempts && !approved; i++) {
      await sleep(kPollIntervalMs);
      try {
        const pending = await mod.listDevicePairing(openclawDir);
        const pendingList = Array.isArray(pending?.pending) ? pending.pending : [];
        const cliPending = pendingList.find((d) => {
          const clientId = String(d.clientId || "").toLowerCase();
          const clientMode = String(d.clientMode || "").toLowerCase();
          return clientId === "cli" || clientMode === "cli";
        });
        if (!cliPending) continue;
        const requestId = String(cliPending.requestId || "").trim();
        if (!requestId) continue;
        const result = await mod.approveDevicePairing(
          requestId,
          { callerScopes: kDeviceApprovalCallerScopes },
          openclawDir,
        );
        if (result?.status === "approved") {
          approved = true;
          // Write marker so pairings.js doesn't duplicate the approval.
          try {
            fs.mkdirSync(paths.internalDir, { recursive: true });
            fs.writeFileSync(
              paths.cliDeviceAutoApprovedPath,
              JSON.stringify({ approvedAt: new Date().toISOString() }, null, 2),
            );
          } catch {}
          console.log("[alphaclaw] CLI device re-provisioned with operator.admin scope");
        }
      } catch {}
    }

    if (!approved) {
      console.warn("[alphaclaw] Could not provision CLI device with admin scope within timeout");
    }

    await triggerPromise;
  } catch (err) {
    console.warn(`[alphaclaw] ensureCliDeviceHasAdminScope error: ${err?.message}`);
  }
};

module.exports = { ensureCliDeviceHasAdminScope };
