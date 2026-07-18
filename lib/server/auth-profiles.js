const fs = require("fs");
const path = require("path");
const { AUTH_PROFILES_PATH, CODEX_PROFILE_ID, OPENCLAW_DIR } = require("./constants");
const { normalizeCodexModelKey, normalizeCodexConfiguredModels } = require("./helpers");
const { syncGatewayProviders } = require("./gateway-provider-config");
const { apiKeyEnvVarByProvider } = require("./model-providers");

const kDefaultAgentId = "main";
// Model Provider id -> api-key env var, derived from the Provider Registry
// (lib/shared/model-providers.json). Do not hardcode a copy here.
const kApiKeyEnvVarByProvider = apiKeyEnvVarByProvider();

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

const credentialHasApiKeyValue = (credential) =>
  credential?.type === "api_key" &&
  String(credential?.key || "").trim().length > 0;

// Build an env-value predicate for the generic gateway-provider writer from an
// auth store. An env var "has a value" when EITHER a stored api_key credential
// for the provider that owns that env var carries a non-empty key, OR the var
// is present in process.env. The process.env arm is essential: on platforms
// like Railway the key is injected as a platform env var (no store credential
// exists — the env→profile mirror only covers env-file vars at onboarding/PUT
// time), and post-boot env-file vars are also reloaded into process.env, so
// process.env is the correct runtime superset. Without it, any unrelated
// credential save/remove would recompute the block as absent and silently drop
// a provider whose key lives only in the environment.
const gatewayEnvValueChecker = (store) => {
  const withValue = new Set();
  for (const credential of Object.values(store?.profiles || {})) {
    if (!credentialHasApiKeyValue(credential)) continue;
    const envVar = kApiKeyEnvVarByProvider[credential.provider];
    if (envVar) withValue.add(envVar);
  }
  return (envVar) =>
    withValue.has(envVar) ||
    String(process.env[envVar] || "").trim().length > 0;
};

// Delegates to the shared generic writer (gateway-provider-config.js) so this
// stays consistent with the boot-time registration: a provider's
// models.providers.<id> block (with its ${ENV_VAR} secret ref) must only exist
// when a real key value is present, since OpenClaw's gateway hard-fails startup
// on any unresolvable secret ref — a cleared/removed key must remove the block,
// not leave it pointing at nothing.
const syncGatewayProviderBlocks = (cfg, hasEnvValue) => {
  const next = { ...cfg, models: { ...cfg.models, providers: { ...cfg.models?.providers } } };
  syncGatewayProviders({ config: next, hasEnvValue });
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
    // `store` already reflects the just-saved credential; recompute every
    // gateway provider block from the full store so glm (and any future
    // plugin-less provider) stays consistent.
    updated = syncGatewayProviderBlocks(updated, gatewayEnvValueChecker(store));
    saveOpenclawConfig(updated);
  };

  const removeProfile = (profileId, agentId = kDefaultAgentId) => {
    const store = loadAuthStore(agentId);
    if (!store.profiles[profileId]) return false;
    delete store.profiles[profileId];
    saveAuthStore(agentId, store);

    if (!canSyncOpenclawAuthReferences()) return true;
    const cfg = loadOpenclawConfig();
    let updated = removeConfigAuthReference(cfg, profileId);
    // `store` no longer holds the removed credential — this drops a now-stale
    // gateway provider block so the gateway doesn't crash-loop on a dangling
    // ${ENV_VAR} secret ref.
    updated = syncGatewayProviderBlocks(updated, gatewayEnvValueChecker(store));
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
    for (const [profileId, credential] of Object.entries(store.profiles || {})) {
      if (!credential?.type || !credential?.provider) continue;
      cfg = syncConfigAuthReference(cfg, profileId, credential);
    }
    cfg = syncGatewayProviderBlocks(cfg, gatewayEnvValueChecker(store));
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
