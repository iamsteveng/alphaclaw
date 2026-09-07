const fs = require("fs");
const path = require("path");
const {
  ALPHACLAW_DIR,
  AUTH_PROFILES_PATH,
  CODEX_PROFILE_ID,
  OPENCLAW_DIR,
} = require("./constants");
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

// ── AlphaClaw-owned credential store ────────────────────────────────────────
// OpenClaw 2026.8.1+ treats <OPENCLAW_DIR>/agents/<id>/agent/auth-profiles.json
// as a LEGACY credential store: its mere presence makes OpenClaw refuse the
// whole auth store ("Auth profile store ... requires legacy credential
// migration; run openclaw doctor --fix"), which breaks every CLI call and any
// cron that shells out to OpenClaw. Credentials that only AlphaClaw itself
// reads back (the X cookie/OAuth1 profiles) therefore must never be written
// into that file — they live under ALPHACLAW_DIR instead.
const kAlphaclawProfilesFile = "alphaclaw-profiles.json";
const kAlphaclawOwnedProviders = new Set(["x-twitter"]);
const kAlphaclawOwnedProfileIdPrefixes = ["x-twitter:"];

const isAlphaclawOwnedProfile = (profileId, credential) => {
  const id = String(profileId || "");
  if (kAlphaclawOwnedProfileIdPrefixes.some((prefix) => id.startsWith(prefix))) {
    return true;
  }
  const provider = String(credential?.provider || "").trim();
  return provider ? kAlphaclawOwnedProviders.has(provider) : false;
};

const resolveAlphaclawProfilesPath = (agentId = kDefaultAgentId) => {
  const id = String(agentId || "").trim() || kDefaultAgentId;
  if (id === kDefaultAgentId) {
    return path.join(ALPHACLAW_DIR, kAlphaclawProfilesFile);
  }
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(ALPHACLAW_DIR, `alphaclaw-profiles.${safe}.json`);
};

const loadAlphaclawStore = (agentId = kDefaultAgentId) => {
  const storePath = resolveAlphaclawProfilesPath(agentId);
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.profiles &&
        typeof parsed.profiles === "object"
      ) {
        return { version: Number(parsed.version || 1), profiles: parsed.profiles };
      }
    }
  } catch {}
  return { version: 1, profiles: {} };
};

const saveAlphaclawStore = (agentId, store) => {
  const storePath = resolveAlphaclawProfilesPath(agentId);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      { version: Number(store?.version || 1), profiles: store?.profiles || {} },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  // mode above only applies on creation; enforce it on pre-existing files too.
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {}
};

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
  // OpenClaw refuses its whole auth store on this file's EXISTENCE, not its
  // content — verified empirically on 2026.9.1, where `{"version":1,"profiles":{}}`
  // raises the same "requires legacy credential migration" error as a populated
  // file. A store with nothing left in it must therefore be deleted rather than
  // written, otherwise removing the last credential (removeCodexProfiles,
  // removeClaudeCodeProfiles, removeProfile, or a setAuthOrder on an empty
  // store) silently re-poisons the install. Any order/lastGood/usageStats
  // metadata goes with it: it only describes profiles that no longer exist.
  if (Object.keys(store.profiles || {}).length === 0) {
    try {
      fs.rmSync(storePath, { force: true });
      // …plus any partial-write sidecar an interrupted save could have left
      // beside it, which would keep the existence check tripping.
      fs.rmSync(`${storePath}.tmp`, { force: true });
      fs.rmSync(`${storePath}.bak`, { force: true });
    } catch {}
    return;
  }
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

// One-way migration off the OpenClaw legacy credential file: move any
// AlphaClaw-owned profile out of <OPENCLAW_DIR>/agents/<id>/agent/auth-profiles.json
// into <ALPHACLAW_DIR>/alphaclaw-profiles.json, strip the moved entries from the
// legacy file, and delete that file entirely when nothing is left in it (its
// presence alone is what makes OpenClaw refuse its auth store). A legacy file
// that still holds real model/provider credentials is preserved — only the
// moved entries are stripped. Fully defensive: an unreadable or corrupt legacy
// file is left untouched and never throws, so boot and CLI reads keep working.
const migrateAlphaclawOwnedProfiles = (agentId = kDefaultAgentId) => {
  const legacyPath = resolveAuthProfilesPath(agentId);
  let raw;
  try {
    if (!fs.existsSync(legacyPath)) return;
    raw = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  } catch {
    return;
  }
  const legacyProfiles =
    raw && typeof raw === "object" && raw.profiles && typeof raw.profiles === "object"
      ? raw.profiles
      : null;
  if (!legacyProfiles) return;
  const movedIds = Object.keys(legacyProfiles).filter((id) =>
    isAlphaclawOwnedProfile(id, legacyProfiles[id]),
  );
  if (movedIds.length === 0) return;

  try {
    const target = loadAlphaclawStore(agentId);
    for (const id of movedIds) {
      // A profile already re-saved into the new store is the fresher copy.
      if (target.profiles[id] === undefined) target.profiles[id] = legacyProfiles[id];
      delete legacyProfiles[id];
    }
    saveAlphaclawStore(agentId, target);

    if (Object.keys(legacyProfiles).length === 0) {
      fs.rmSync(legacyPath, { force: true });
    } else {
      raw.profiles = legacyProfiles;
      fs.writeFileSync(legacyPath, JSON.stringify(raw, null, 2));
    }
  } catch {
    return;
  }

  // Drop the now-dangling openclaw.json auth references for the moved
  // profiles; OpenClaw never reads these credentials.
  try {
    if (!canSyncOpenclawAuthReferences()) return;
    let cfg = loadOpenclawConfig();
    let changed = false;
    for (const id of movedIds) {
      if (cfg.auth?.profiles?.[id]) {
        cfg = removeConfigAuthReference(cfg, id);
        changed = true;
      }
    }
    if (changed) saveOpenclawConfig(cfg);
  } catch {}
};

const createAuthProfiles = () => {
  // Lazy and idempotent, so it can guard every read/write entry point instead
  // of needing a boot hook — which also covers the CLI read path (x-list-crawl)
  // that never runs startup.js. Cost per call: one existsSync, plus a read and
  // JSON.parse of the legacy file while one exists (the normal state as long as
  // real provider credentials still live there); it writes only when that file
  // actually holds AlphaClaw-owned entries.
  const ensureMigrated = (agentId = kDefaultAgentId) => {
    try {
      migrateAlphaclawOwnedProfiles(agentId);
    } catch {}
  };

  // ── Generic profile operations ──

  const listProfiles = (agentId = kDefaultAgentId) => {
    ensureMigrated(agentId);
    const store = loadAuthStore(agentId);
    const merged = {
      ...(store.profiles || {}),
      ...(loadAlphaclawStore(agentId).profiles || {}),
    };
    return Object.entries(merged).map(([id, cred]) => ({
      id,
      ...cred,
    }));
  };

  const listProfilesByProvider = (provider, agentId = kDefaultAgentId) =>
    listProfiles(agentId).filter((p) => p.provider === provider);

  const getProfile = (profileId, agentId = kDefaultAgentId) => {
    ensureMigrated(agentId);
    const cred =
      loadAlphaclawStore(agentId).profiles?.[profileId] ??
      loadAuthStore(agentId).profiles?.[profileId];
    if (!cred) return null;
    return { id: profileId, ...cred };
  };

  const upsertProfile = (profileId, credential, agentId = kDefaultAgentId) => {
    ensureMigrated(agentId);
    const sanitized = { ...credential };
    if (sanitized.key) sanitized.key = normalizeSecret(sanitized.key);
    if (sanitized.token) sanitized.token = normalizeSecret(sanitized.token);
    if (sanitized.access) sanitized.access = normalizeSecret(sanitized.access);
    if (sanitized.refresh)
      sanitized.refresh = normalizeSecret(sanitized.refresh);

    // AlphaClaw-owned credentials never enter the OpenClaw agent directory and
    // are never referenced from openclaw.json — OpenClaw does not read them.
    if (isAlphaclawOwnedProfile(profileId, sanitized)) {
      const owned = loadAlphaclawStore(agentId);
      owned.profiles[profileId] = sanitized;
      saveAlphaclawStore(agentId, owned);
      return;
    }

    const store = loadAuthStore(agentId);
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
    ensureMigrated(agentId);
    const owned = loadAlphaclawStore(agentId);
    if (owned.profiles[profileId]) {
      delete owned.profiles[profileId];
      saveAlphaclawStore(agentId, owned);
      return true;
    }

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
    loadAuthStore: (agentId = kDefaultAgentId) => {
      ensureMigrated(agentId);
      return loadAuthStore(agentId);
    },
  };
};

module.exports = {
  createAuthProfiles,
  getEnvVarForApiKeyProvider,
  isAlphaclawOwnedProfile,
  resolveAlphaclawProfilesPath,
};
