const fs = require("fs");
const path = require("path");
const { AUTH_PROFILES_PATH, CODEX_PROFILE_ID, OPENCLAW_DIR } = require("./constants");
const { normalizeCodexModelKey, normalizeCodexConfiguredModels } = require("./helpers");

const kDefaultAgentId = "main";
const kApiKeyEnvVarByProvider = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  opencode: "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  kilocode: "KILOCODE_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  volcengine: "VOLCANO_ENGINE_API_KEY",
  byteplus: "BYTEPLUS_API_KEY",
  synthetic: "SYNTHETIC_API_KEY",
  minimax: "MINIMAX_API_KEY",
  voyage: "VOYAGE_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  glm: "GLM_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  vllm: "VLLM_API_KEY",
};

// `glm` has no bundled OpenClaw provider plugin (unlike `zai`), so AlphaClaw
// must pin its base URL and model list into openclaw.json's generic
// `models.providers.<id>` custom-provider config itself.
const GLM_PROVIDER_ID = "glm";
const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const kGlmProviderModels = [
  { id: "glm-5.2", name: "GLM-5.2" },
  { id: "glm-5.1", name: "GLM-5.1" },
  { id: "glm-5-turbo", name: "GLM-5-Turbo" },
  { id: "glm-5", name: "GLM-5" },
  { id: "glm-4.7", name: "GLM-4.7" },
  { id: "glm-4.7-flash", name: "GLM-4.7-Flash" },
  { id: "glm-4.7-flashx", name: "GLM-4.7-FlashX" },
  { id: "glm-4.6", name: "GLM-4.6" },
  { id: "glm-4.5-air", name: "GLM-4.5-Air" },
  { id: "glm-4.5-airx", name: "GLM-4.5-AirX" },
  { id: "glm-4.5-flash", name: "GLM-4.5-Flash" },
  { id: "glm-4-flash-250414", name: "GLM-4-Flash (250414)" },
  { id: "glm-4-flashx-250414", name: "GLM-4-FlashX (250414)" },
  { id: "glm-5v-turbo", name: "GLM-5V-Turbo", input: ["text", "image"] },
  { id: "glm-4.6v", name: "GLM-4.6V", input: ["text", "image"] },
  { id: "glm-4.6v-flash", name: "GLM-4.6V-Flash", input: ["text", "image"] },
  { id: "glm-4.6v-flashx", name: "GLM-4.6V-FlashX", input: ["text", "image"] },
  { id: "glm-4v-flash", name: "GLM-4V-Flash", input: ["text", "image"] },
  {
    id: "glm-4.1v-thinking-flashx",
    name: "GLM-4.1V-Thinking-FlashX",
    input: ["text", "image"],
  },
  {
    id: "glm-4.1v-thinking-flash",
    name: "GLM-4.1V-Thinking-Flash",
    input: ["text", "image"],
  },
  { id: "autoglm-phone", name: "AutoGLM Phone", input: ["text", "image"] },
  { id: "glm-4-voice", name: "GLM-4-Voice" },
  { id: "charglm-4", name: "CharGLM-4" },
  { id: "emohaa", name: "Emohaa" },
];

const normalizeSecret = (raw) =>
  String(raw ?? "")
    .replace(/[\r\n\u2028\u2029]/g, "")
    .trim();

const credentialMode = (credential) => {
  if (credential.type === "api_key") return "api_key";
  if (credential.type === "token") return "token";
  return "oauth";
};

const getEnvVarForApiKeyProvider = (provider) =>
  kApiKeyEnvVarByProvider[String(provider || "").trim()] || "";

const listApiKeyProviders = () => Object.keys(kApiKeyEnvVarByProvider);

const getDefaultProfileIdForApiKeyProvider = (provider) => {
  const normalized = String(provider || "").trim();
  return normalized ? `${normalized}:default` : "";
};

const resolveAgentDir = (agentId = kDefaultAgentId) =>
  path.join(OPENCLAW_DIR, "agents", agentId, "agent");

const resolveAuthProfilesPath = (agentId = kDefaultAgentId) =>
  path.join(resolveAgentDir(agentId), "auth-profiles.json");

const resolveOpenclawConfigPath = () =>
  path.join(OPENCLAW_DIR, "openclaw.json");

const hasCompletedOnboardingConfig = (cfg) =>
  String(cfg?.agents?.defaults?.model?.primary || "").trim().includes("/");

const loadAuthStore = (agentId = kDefaultAgentId) => {
  const storePath = resolveAuthProfilesPath(agentId);
  let store = { version: 1, profiles: {} };
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.profiles &&
        typeof parsed.profiles === "object"
      ) {
        store = {
          version: Number(parsed.version || 1),
          profiles: parsed.profiles,
          order: parsed.order,
          lastGood: parsed.lastGood,
          usageStats: parsed.usageStats,
        };
      }
    }
  } catch {}
  return store;
};

const saveAuthStore = (agentId, store) => {
  const storePath = resolveAuthProfilesPath(agentId);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        version: Number(store.version || 1),
        profiles: store.profiles || {},
        ...(store.order !== undefined ? { order: store.order } : {}),
        ...(store.lastGood !== undefined ? { lastGood: store.lastGood } : {}),
        ...(store.usageStats !== undefined
          ? { usageStats: store.usageStats }
          : {}),
      },
      null,
      2,
    ),
  );
};

const loadOpenclawConfig = () => {
  const configPath = resolveOpenclawConfigPath();
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
};

const canSyncOpenclawAuthReferences = () => {
  const configPath = resolveOpenclawConfigPath();
  if (!fs.existsSync(configPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return hasCompletedOnboardingConfig(cfg);
  } catch {
    return false;
  }
};

const saveOpenclawConfig = (cfg) => {
  const configPath = resolveOpenclawConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
};

const syncConfigAuthReference = (cfg, profileId, credential) => {
  const next = { ...cfg };
  if (!next.auth) next.auth = {};
  if (!next.auth.profiles) next.auth.profiles = {};
  next.auth = { ...next.auth, profiles: { ...next.auth.profiles } };
  next.auth.profiles[profileId] = {
    provider: credential.provider,
    mode: credentialMode(credential),
  };
  return next;
};

const syncGlmProviderConfig = (cfg) => {
  const next = { ...cfg };
  next.models = { ...next.models };
  next.models.providers = { ...next.models.providers };
  next.models.providers[GLM_PROVIDER_ID] = {
    baseUrl: GLM_BASE_URL,
    apiKey: "${GLM_API_KEY}",
    api: "openai-completions",
    models: kGlmProviderModels,
  };
  return next;
};

const removeConfigAuthReference = (cfg, profileId) => {
  if (!cfg.auth?.profiles?.[profileId]) return cfg;
  const next = { ...cfg };
  next.auth = { ...next.auth, profiles: { ...next.auth.profiles } };
  delete next.auth.profiles[profileId];
  if (Object.keys(next.auth.profiles).length === 0) {
    delete next.auth.profiles;
  }
  if (Object.keys(next.auth).length === 0) {
    delete next.auth;
  }
  return next;
};

const createAuthProfiles = () => {
  // ── Generic profile operations ──

  const listProfiles = (agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    return Object.entries(store.profiles || {}).map(([id, cred]) => ({
      id,
      ...cred,
    }));
  };

  const listProfilesByProvider = (provider, agentId = kDefaultAgentId) =>
    listProfiles(agentId).filter((p) => p.provider === provider);

  const getProfile = (profileId, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    const cred = store.profiles?.[profileId];
    if (!cred) return null;
    return { id: profileId, ...cred };
  };

  const upsertProfile = (profileId, credential, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    const sanitized = { ...credential };
    if (sanitized.key) sanitized.key = normalizeSecret(sanitized.key);
    if (sanitized.token) sanitized.token = normalizeSecret(sanitized.token);
    if (sanitized.access) sanitized.access = normalizeSecret(sanitized.access);
    if (sanitized.refresh)
      sanitized.refresh = normalizeSecret(sanitized.refresh);
    store.profiles[profileId] = sanitized;
    saveAuthStore(agentId, store);

    if (!canSyncOpenclawAuthReferences()) return;
    const cfg = loadOpenclawConfig();
    let updated = syncConfigAuthReference(cfg, profileId, sanitized);
    if (sanitized.provider === GLM_PROVIDER_ID) {
      updated = syncGlmProviderConfig(updated);
    }
    saveOpenclawConfig(updated);
  };

  const removeProfile = (profileId, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    if (!store.profiles[profileId]) return false;
    delete store.profiles[profileId];
    saveAuthStore(agentId, store);

    if (!canSyncOpenclawAuthReferences()) return true;
    const cfg = loadOpenclawConfig();
    const updated = removeConfigAuthReference(cfg, profileId);
    saveOpenclawConfig(updated);
    return true;
  };

  const setAuthOrder = (provider, orderedProfileIds, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    if (!store.order) store.order = {};
    store.order[provider] = orderedProfileIds;
    saveAuthStore(agentId, store);
  };

  const syncConfigAuthReferencesForAgent = (agentId = kDefaultAgentId) => {
    if (!canSyncOpenclawAuthReferences()) return;
    const store = loadAuthStore(agentId);
    let cfg = loadOpenclawConfig();
    let hasGlmProfile = false;
    for (const [profileId, credential] of Object.entries(store.profiles || {})) {
      if (!credential?.type || !credential?.provider) continue;
      cfg = syncConfigAuthReference(cfg, profileId, credential);
      if (credential.provider === GLM_PROVIDER_ID) hasGlmProfile = true;
    }
    if (hasGlmProfile) cfg = syncGlmProviderConfig(cfg);
    saveOpenclawConfig(cfg);
  };

  const upsertApiKeyProfileForEnvVar = (
    provider,
    rawValue,
    agentId = kDefaultAgentId,
  ) => {
    const key = normalizeSecret(rawValue);
    if (!provider || !key) return false;
    upsertProfile(
      getDefaultProfileIdForApiKeyProvider(provider),
      {
        type: "api_key",
        provider,
        key,
      },
      agentId,
    );
    return true;
  };

  const removeApiKeyProfileForEnvVar = (provider, agentId = kDefaultAgentId) => {
    const profileId = getDefaultProfileIdForApiKeyProvider(provider);
    if (!profileId) return false;
    const existing = getProfile(profileId, agentId);
    if (!existing) return false;
    if (existing.type !== "api_key" || existing.provider !== provider) return false;
    return removeProfile(profileId, agentId);
  };

  // ── Model config operations ──

  const getModelConfig = () => {
    const cfg = loadOpenclawConfig();
    const defaults = cfg.agents?.defaults || {};
    return {
      primary: defaults.model?.primary || null,
      configuredModels: defaults.models || {},
    };
  };

  const setModelConfig = ({ primary, configuredModels }) => {
    const cfg = loadOpenclawConfig();
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.model) cfg.agents.defaults.model = {};
    if (primary !== undefined) {
      cfg.agents.defaults.model.primary = normalizeCodexModelKey(primary);
    }
    if (configuredModels !== undefined) {
      cfg.agents.defaults.models = configuredModels;
    }
    saveOpenclawConfig(cfg);
  };

  // ── Legacy Codex-specific wrappers ──

  const listCodexProfiles = () => listProfilesByProvider("openai-codex");

  const getCodexProfile = () => {
    const profiles = listCodexProfiles();
    if (profiles.length === 0) return null;
    const preferred =
      profiles.find((p) => p.id === CODEX_PROFILE_ID) || profiles[0];
    return { profileId: preferred.id, ...preferred };
  };

  const hasCodexOauthProfile = () => {
    const profile = getCodexProfile();
    return !!(profile?.access && profile?.refresh);
  };

  const upsertCodexProfile = ({ access, refresh, expires, accountId }) => {
    upsertProfile(CODEX_PROFILE_ID, {
      type: "oauth",
      provider: "openai-codex",
      access,
      refresh,
      expires,
      ...(accountId ? { accountId } : {}),
    });
  };

  const removeCodexProfiles = () => {
    const store = loadAuthStore();
    let changed = false;
    for (const [id, cred] of Object.entries(store.profiles || {})) {
      if (cred?.provider === "openai-codex") {
        delete store.profiles[id];
        changed = true;
      }
    }
    if (changed) {
      saveAuthStore(kDefaultAgentId, store);
      if (!canSyncOpenclawAuthReferences()) return changed;
      let cfg = loadOpenclawConfig();
      for (const [id, cred] of Object.entries(cfg.auth?.profiles || {})) {
        if (cred?.provider === "openai-codex") {
          cfg = removeConfigAuthReference(cfg, id);
        }
      }
      saveOpenclawConfig(cfg);
    }
    return changed;
  };

  // ── Claude Code-specific wrappers ──

  const CLAUDE_CODE_PROFILE_ID = 'claude-code:cli';

  const listClaudeCodeProfiles = () => listProfilesByProvider('claude-code');

  const getClaudeCodeProfile = () => {
    const profiles = listClaudeCodeProfiles();
    if (profiles.length === 0) return null;
    return { profileId: profiles[0].id, ...profiles[0] };
  };

  const hasClaudeCodeOauthProfile = () => {
    const profile = getClaudeCodeProfile();
    return !!(profile?.access && profile?.refresh);
  };

  const upsertClaudeCodeProfile = ({ accessToken, refreshToken, expiresAt, scopes }) => {
    upsertProfile(CLAUDE_CODE_PROFILE_ID, {
      type: 'oauth',
      provider: 'claude-code',
      access: accessToken,
      refresh: refreshToken || '',
      expires: expiresAt || 0,
      scopes: scopes || ['user:inference'],
    });
  };

  const removeClaudeCodeProfiles = () => {
    const store = loadAuthStore();
    let changed = false;
    for (const [id, cred] of Object.entries(store.profiles || {})) {
      if (cred?.provider === 'claude-code') {
        delete store.profiles[id];
        changed = true;
      }
    }
    if (changed) saveAuthStore(kDefaultAgentId, store);
    return changed;
  };

  return {
    listProfiles,
    listProfilesByProvider,
    getProfile,
    upsertProfile,
    removeProfile,
    setAuthOrder,
    syncConfigAuthReferencesForAgent,
    upsertApiKeyProfileForEnvVar,
    removeApiKeyProfileForEnvVar,
    getEnvVarForApiKeyProvider,
    listApiKeyProviders,
    getDefaultProfileIdForApiKeyProvider,
    getModelConfig,
    setModelConfig,
    getCodexProfile,
    hasCodexOauthProfile,
    upsertCodexProfile,
    removeCodexProfiles,
    getClaudeCodeProfile,
    hasClaudeCodeOauthProfile,
    upsertClaudeCodeProfile,
    removeClaudeCodeProfiles,
    loadAuthStore,
  };
};

module.exports = { createAuthProfiles, getEnvVarForApiKeyProvider };
