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

  // Without this, ACP sessions launch with Claude Code's default (interactive)
  // permission mode. There is no TTY to answer an approval prompt in this
  // dispatch path, so the very first tool call hangs the session forever with
  // no error and no reply. approve-all trades that hang for unattended tool use.
  cfg.plugins = cfg.plugins || {};
  cfg.plugins.entries = cfg.plugins.entries || {};
  cfg.plugins.entries.acpx = cfg.plugins.entries.acpx || {};
  cfg.plugins.entries.acpx.config = cfg.plugins.entries.acpx.config || {};
  if (!cfg.plugins.entries.acpx.config.permissionMode) {
    cfg.plugins.entries.acpx.config.permissionMode = "approve-all";
  }

  // Without this, source-reply delivery mode for a bound ACP conversation's
  // follow-up turns can resolve to "message_tool_only" (replies are generated
  // correctly but kept private unless the agent explicitly calls a message
  // delivery tool). Claude Code via ACP never calls that tool for plain
  // conversational replies, so the turn completes with no visible error but
  // the answer is silently never delivered to the channel. "automatic" forces
  // normal replies to post directly, matching how non-ACP agent replies
  // already behave.
  cfg.messages = cfg.messages || {};
  if (!cfg.messages.visibleReplies) {
    cfg.messages.visibleReplies = "automatic";
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
