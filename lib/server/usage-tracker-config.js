const path = require("path");
const { readOpenclawConfig, writeOpenclawConfig } = require("./openclaw-config");

const kUsageTrackerPluginPath = path.resolve(
  __dirname,
  "..",
  "plugin",
  "usage-tracker",
);
const ensurePluginsShell = (cfg = {}) => {
  if (!cfg.plugins || typeof cfg.plugins !== "object") cfg.plugins = {};
  if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];
  if (!cfg.plugins.load || typeof cfg.plugins.load !== "object") {
    cfg.plugins.load = {};
  }
  if (!Array.isArray(cfg.plugins.load.paths)) cfg.plugins.load.paths = [];
  if (!cfg.plugins.entries || typeof cfg.plugins.entries !== "object") {
    cfg.plugins.entries = {};
  }
};

const ensurePluginAllowed = ({ cfg = {}, pluginKey = "" }) => {
  const normalizedPluginKey = String(pluginKey || "").trim();
  if (!normalizedPluginKey) return;
  ensurePluginsShell(cfg);
  if (!cfg.plugins.allow.includes(normalizedPluginKey)) {
    cfg.plugins.allow.push(normalizedPluginKey);
  }
};

const ensureUsageTrackerPluginEntry = (cfg = {}) => {
  const before = JSON.stringify(cfg);
  ensurePluginAllowed({ cfg, pluginKey: "usage-tracker" });
  // Remove stale usage-tracker paths (e.g. old @chrysb/alphaclaw npm package path from pre-monorepo)
  cfg.plugins.load.paths = cfg.plugins.load.paths.filter(
    (p) => path.basename(p) !== "usage-tracker" || p === kUsageTrackerPluginPath,
  );
  if (!cfg.plugins.load.paths.includes(kUsageTrackerPluginPath)) {
    cfg.plugins.load.paths.push(kUsageTrackerPluginPath);
  }
  // Custom plugins loaded via plugins.load.paths must NOT have a plugins.entries entry —
  // openclaw validates entries against its bundled plugin registry before loading custom paths,
  // and rejects the config with "plugin not found" for any unrecognised entry key.
  if (cfg.plugins.entries["usage-tracker"] !== undefined) {
    delete cfg.plugins.entries["usage-tracker"];
  }
  return JSON.stringify(cfg) !== before;
};

const ensureUsageTrackerPluginConfig = ({ fsModule, openclawDir }) => {
  const cfg = readOpenclawConfig({
    fsModule,
    openclawDir,
    fallback: {},
  });
  const changed = ensureUsageTrackerPluginEntry(cfg);
  if (!changed) return false;
  writeOpenclawConfig({
    fsModule,
    openclawDir,
    config: cfg,
    spacing: 2,
  });
  return true;
};

module.exports = {
  kUsageTrackerPluginPath,
  ensurePluginsShell,
  ensurePluginAllowed,
  ensureUsageTrackerPluginEntry,
  ensureUsageTrackerPluginConfig,
};
