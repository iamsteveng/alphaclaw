const createRestartRequiredState = ({ isGatewayRunning }) => {
  const state = {
    restartRequired: false,
    restartInProgress: false,
    sawGatewayDownSincePending: false,
    updatedAt: Date.now(),
    reason: "",
  };

  const touch = () => {
    state.updatedAt = Date.now();
  };

  const markRequired = (reason = "config_changed") => {
    state.restartRequired = true;
    state.reason = reason;
    state.sawGatewayDownSincePending = false;
    touch();
  };

  const markRestartInProgress = () => {
    state.restartInProgress = true;
    touch();
  };

  const markRestartComplete = () => {
    state.restartInProgress = false;
    touch();
  };

  const clearRequired = () => {
    state.restartRequired = false;
    state.reason = "";
    state.sawGatewayDownSincePending = false;
    touch();
  };

  const checkAndClearIfRecovered = async () => {
    const gatewayRunning = await isGatewayRunning();
    if (state.restartRequired && !state.restartInProgress) {
      if (!gatewayRunning) {
        state.sawGatewayDownSincePending = true;
        touch();
      } else if (state.sawGatewayDownSincePending) {
        clearRequired();
      }
    }
    return gatewayRunning;
  };

  const getSnapshot = async () => {
    const gatewayRunning = await checkAndClearIfRecovered();
    return {
      restartRequired: state.restartRequired,
      restartInProgress: state.restartInProgress,
      gatewayRunning,
      updatedAt: state.updatedAt,
    };
  };

  return {
    markRequired,
    markRestartInProgress,
    markRestartComplete,
    clearRequired,
    getSnapshot,
  };
};

const waitForGatewayRunning = async ({
  isGatewayRunning,
  timeoutMs = 25000,
  intervalMs = 400,
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return isGatewayRunning();
};

module.exports = {
  createRestartRequiredState,
  waitForGatewayRunning,
};
