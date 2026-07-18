const { readOpenclawConfig, writeOpenclawConfig } = require("./openclaw-config");
const { providersWithGatewayConfig } = require("./model-providers");

// Some Model Providers have no bundled OpenClaw provider plugin (e.g. `glm`),
// so they must be registered as custom `models.providers.<id>` entries for
// OpenClaw's own catalog to know about them. The registry (lib/shared/
// model-providers.json) carries a `gatewayProvider` block for each such
// provider; this module is the single seam that materialises those blocks into
// openclaw.json.
//
// IMPORTANT — the crash-loop invariant: OpenClaw's gateway eagerly resolves
// every `${VAR}` secret reference found anywhere in openclaw.json at startup
// and hard-fails the *whole* gateway (not just that provider) if one is
// missing/empty ("SecretRefResolutionError"). Each gatewayProvider block
// contains an `apiKey: "${ENV_VAR}"` ref, so a block may only exist once its
// env var actually has a value. When the value is absent, any previously
// written block must be removed so a prior broken write self-heals on the next
// sync instead of crash-looping forever. This function enforces that at one
// place for every gateway provider.

const deepClone = (value) => JSON.parse(JSON.stringify(value));

// Pure writer over the config object. For every registry entry with a
// `gatewayProvider` block: if `hasEnvValue(entry.envVar)` is truthy, ensure
// config.models.providers[id] deep-equals the registry block; otherwise remove
// a stale block if present. Mutates `config`, returns whether anything changed.
// No fs here — callers own read/write of openclaw.json.
const syncGatewayProviders = ({ config = {}, hasEnvValue, table } = {}) => {
  const check = typeof hasEnvValue === "function" ? hasEnvValue : () => false;
  let changed = false;
  for (const entry of providersWithGatewayConfig(table)) {
    const id = entry.id;
    const before = JSON.stringify(config.models?.providers?.[id] ?? null);
    if (check(entry.envVar)) {
      config.models = config.models || {};
      config.models.providers = config.models.providers || {};
      config.models.providers[id] = deepClone(entry.gatewayProvider);
    } else if (config.models?.providers?.[id]) {
      delete config.models.providers[id];
    }
    const after = JSON.stringify(config.models?.providers?.[id] ?? null);
    if (after !== before) changed = true;
  }
  return changed;
};

// fs-backed convenience wrapper: read openclaw.json, sync the gateway provider
// blocks, write back only if the
// config actually changed. Returns whether the file was rewritten.
const ensureGatewayProviderConfig = ({ fsModule, openclawDir, hasEnvValue, table } = {}) => {
  const config = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
  const changed = syncGatewayProviders({ config, hasEnvValue, table });
  if (!changed) return false;
  writeOpenclawConfig({ fsModule, openclawDir, config, spacing: 2 });
  return true;
};

module.exports = {
  syncGatewayProviders,
  ensureGatewayProviderConfig,
};
