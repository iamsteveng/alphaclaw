const { readOpenclawConfig, writeOpenclawConfig } = require("./openclaw-config");

const ensureAcpEntry = (cfg = {}) => {
  const before = JSON.stringify(cfg);

  cfg.acp = cfg.acp || {};
  if (cfg.acp.enabled === undefined) cfg.acp.enabled = true;
  cfg.acp.dispatch = cfg.acp.dispatch || {};
  if (cfg.acp.dispatch.enabled === undefined) cfg.acp.dispatch.enabled = true;
  if (!cfg.acp.defaultAgent) cfg.acp.defaultAgent = "claude";

  cfg.agents = cfg.agents || {};
  if (!Array.isArray(cfg.agents.list)) cfg.agents.list = [];
  if (!cfg.agents.list.some((agent) => agent?.id === "claude")) {
    cfg.agents.list.push({
      id: "claude",
      runtime: {
        type: "acp",
        acp: { agent: "claude", backend: "acpx", mode: "persistent" },
      },
    });
  }

  return JSON.stringify(cfg) !== before;
};

const ensureAcpAgentConfig = ({ fsModule, openclawDir }) => {
  const cfg = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
  const changed = ensureAcpEntry(cfg);
  if (!changed) return false;
  writeOpenclawConfig({ fsModule, openclawDir, config: cfg, spacing: 2 });
  return true;
};

module.exports = { ensureAcpEntry, ensureAcpAgentConfig };
