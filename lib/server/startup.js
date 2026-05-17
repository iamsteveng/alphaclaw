const fs = require('fs');
const { ensureClaudeCodeAuth } = require('./claude-code-auth');
const { ensureXTwitterAuth } = require('./x-twitter-auth');
const { OPENCLAW_DIR } = require('./constants');
const { buildManagedPaths } = require('./internal-files-migration');
const { parseJsonObjectFromNoisyOutput } = require('./utils/json');

const kDeviceApprovalCallerScopes = [
  'operator.admin',
  'operator.read',
  'operator.write',
  'operator.approvals',
  'operator.pairing',
  'operator.talk.secrets',
];

let deviceBootstrapModulePromise = null;
const loadDeviceBootstrapModule = () => {
  deviceBootstrapModulePromise ||= import('openclaw/plugin-sdk/device-bootstrap');
  return deviceBootstrapModulePromise;
};

// Mirrors the auto-approve logic in pairings.js but runs at startup so that
// pending CLI device requests created during openclaw quickstart are approved
// with operator.admin scope before cron admin commands are first attempted.
const autoApproveCliDeviceOnStartup = async ({ clawCmd, openclawDir = OPENCLAW_DIR } = {}) => {
  try {
    const paths = buildManagedPaths({ openclawDir });
    if (fs.existsSync(paths.cliDeviceAutoApprovedPath)) return;

    const result = await clawCmd('devices list --json', { quiet: true, timeoutMs: 8000 });
    if (!result?.ok) return;

    const parsed = parseJsonObjectFromNoisyOutput(result.stdout);
    const pendingList = Array.isArray(parsed?.pending) ? parsed.pending : [];
    const cliPending = pendingList.find((d) => {
      const clientId = String(d.clientId || '').toLowerCase();
      const clientMode = String(d.clientMode || '').toLowerCase();
      return clientId === 'cli' || clientMode === 'cli';
    });
    if (!cliPending) return;

    const requestId = String(cliPending.requestId || cliPending.id || '').trim();
    if (!requestId) return;

    const mod = await loadDeviceBootstrapModule();
    const approval = await mod.approveDevicePairing(
      requestId,
      { callerScopes: kDeviceApprovalCallerScopes },
      openclawDir,
    );
    if (approval?.status === 'approved') {
      try {
        fs.mkdirSync(paths.internalDir, { recursive: true });
        fs.writeFileSync(
          paths.cliDeviceAutoApprovedPath,
          JSON.stringify({ approvedAt: new Date().toISOString() }, null, 2),
        );
      } catch {}
      console.log('[alphaclaw] CLI device auto-approved with operator.admin scope on startup');
    }
  } catch (err) {
    console.warn('[alphaclaw] CLI device startup auto-approve error:', err?.message);
  }
};

const runOnboardedBootSequence = ({
  ensureManagedExecDefaults,
  ensureUsageTrackerPluginConfig,
  doSyncPromptFiles,
  reloadEnv,
  syncChannelConfig,
  readEnvFile,
  ensureGatewayProxyConfig,
  resolveSetupUrl,
  startGateway,
  watchdog,
  gmailWatchService,
  clawCmd,
}) => {
  ensureClaudeCodeAuth().catch((err) =>
    console.error('[alphaclaw] Claude Code auth init failed:', err.message),
  );
  try { ensureXTwitterAuth(); } catch (err) {
    console.error('[alphaclaw] X Twitter auth init failed:', err.message);
  }
  try {
    ensureManagedExecDefaults();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure managed exec defaults on boot: ${error.message}`,
    );
  }
  try {
    ensureUsageTrackerPluginConfig();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure usage-tracker plugin config on boot: ${error.message}`,
    );
  }
  doSyncPromptFiles();
  reloadEnv();
  syncChannelConfig(readEnvFile());
  ensureGatewayProxyConfig(resolveSetupUrl());
  startGateway();
  watchdog.start();
  gmailWatchService.start();
  // Approve any pending CLI device request with admin scope 8 s after boot,
  // giving the gateway time to come up. Same logic as /api/devices auto-approve.
  if (clawCmd) {
    setTimeout(() => {
      autoApproveCliDeviceOnStartup({ clawCmd }).catch(() => {});
    }, 8000);
  }
};

module.exports = {
  runOnboardedBootSequence,
};
