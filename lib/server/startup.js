const { execSync } = require('child_process');
const path = require('path');
const { kRootDir, WORKSPACE_DIR } = require('./constants');
const { ensureClaudeCodeAuth } = require('./claude-code-auth');
const { ensureXTwitterAuth } = require('./x-twitter-auth');

const kGbrainRecoveryDelayMs = 30 * 1000;

const runGbrainRecoveryCheck = () => {
  const brainDir = path.join(WORKSPACE_DIR, 'brain');
  try {
    let pageCount = 0;
    try {
      const out = execSync(
        `timeout 10 env HOME=${kRootDir} gbrain list 2>/dev/null`,
        { encoding: 'utf8', shell: true },
      ).trim();
      // gbrain prints "No pages found." (one line) on empty brain — not a page entry
      if (out && !/No pages found/i.test(out)) {
        pageCount = out.split('\n').filter(Boolean).length;
      }
    } catch {
      pageCount = 0;
    }

    console.log(`[alphaclaw] gbrain health check: ${pageCount} pages`);

    if (pageCount === 0) {
      let flatFileCount = 0;
      try {
        const out = execSync(
          `find ${brainDir} -name "*.md" 2>/dev/null | wc -l`,
          { encoding: 'utf8', shell: true },
        ).trim();
        flatFileCount = parseInt(out, 10) || 0;
      } catch { /* brain dir may not exist yet */ }

      if (flatFileCount > 0) {
        console.log(
          `[alphaclaw] gbrain empty but ${flatFileCount} flat files found — running auto-recovery import`,
        );
        try {
          execSync(
            `env HOME=${kRootDir} gbrain import ${brainDir} --no-embed`,
            { timeout: 120000, shell: true, stdio: 'inherit' },
          );
          console.log('[alphaclaw] gbrain auto-recovery import complete');
        } catch (importErr) {
          console.error('[alphaclaw] gbrain auto-recovery import failed:', importErr.message);
        }
      } else {
        console.log('[alphaclaw] gbrain health check: no pages and no flat files — skipping recovery');
      }
    }
  } catch (err) {
    console.error('[alphaclaw] gbrain health check error:', err.message);
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
  setTimeout(runGbrainRecoveryCheck, kGbrainRecoveryDelayMs);
};

module.exports = {
  runOnboardedBootSequence,
};
