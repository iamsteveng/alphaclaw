const { ensureClaudeCodeAuth } = require('./claude-code-auth');
const { ensureXTwitterAuth } = require('./x-twitter-auth');

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
};

module.exports = {
  runOnboardedBootSequence,
};
