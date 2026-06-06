const startServerLifecycle = ({
  server,
  PORT,
  isOnboarded,
  runOnboardedBootSequence,
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
  finnhubPoller,
}) => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[alphaclaw] Express listening on :${PORT}`);
    if (isOnboarded()) {
      runOnboardedBootSequence({
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
        finnhubPoller,
      });
    } else {
      console.log("[alphaclaw] Awaiting onboarding via Setup UI");
    }
  });
};

const registerServerShutdown = ({ gmailWatchService, finnhubPoller, watchdogTerminal }) => {
  const shutdownGmailWatchService = async () => {
    try {
      await gmailWatchService.stop();
    } catch {}
    try { finnhubPoller.stop(); } catch {}
    watchdogTerminal.disposeSession();
  };

  process.on("SIGTERM", () => {
    shutdownGmailWatchService();
  });
  process.on("SIGINT", () => {
    shutdownGmailWatchService();
  });
};

module.exports = {
  startServerLifecycle,
  registerServerShutdown,
};
