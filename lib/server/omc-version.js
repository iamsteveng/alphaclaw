const { execSync } = require("child_process");
const { kVersionCacheTtlMs } = require("./constants");

const createOmcVersionService = ({ gatewayEnv }) => {
  let kOmcVersionCache = { value: null, fetchedAt: 0 };

  const readOmcVersion = ({ refresh = false } = {}) => {
    const now = Date.now();
    if (
      !refresh &&
      kOmcVersionCache.value &&
      now - kOmcVersionCache.fetchedAt < kVersionCacheTtlMs
    ) {
      return kOmcVersionCache.value;
    }
    try {
      const raw = execSync("oh-my-claudecode --version", {
        env: gatewayEnv(),
        timeout: 5000,
        encoding: "utf8",
      }).trim();
      kOmcVersionCache = { value: raw || null, fetchedAt: now };
      return kOmcVersionCache.value;
    } catch {
      return kOmcVersionCache.value;
    }
  };

  return { readOmcVersion };
};

module.exports = { createOmcVersionService };
