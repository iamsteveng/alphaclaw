// Provider Registry accessor (see CONTEXT.md → "Provider Registry").
//
// This module is the single seam through which backend code reads Model
// Provider identity. The table itself lives in ../shared/model-providers.json
// so the frontend bundle can import the same data (PR B). Keep this module a
// pure set of lookups — it must NOT require ./constants (constants.js requires
// this module, so importing it back would create a cycle).
const kDefaultTable = require("../shared/model-providers.json");

// Every accessor takes an optional `table` param (default = the shipped JSON)
// so tests can exercise the derivations against a synthetic registry — adding
// one entry there must surface everywhere without touching this module.
const listProviders = (table = kDefaultTable) => table.slice();

const getProvider = (id, table = kDefaultTable) =>
  table.find((entry) => entry.id === id) || null;

// id -> envVar object, shaped exactly like the old kApiKeyEnvVarByProvider map.
const apiKeyEnvVarByProvider = (table = kDefaultTable) => {
  const out = {};
  for (const entry of table) out[entry.id] = entry.envVar;
  return out;
};

// Provider ids eligible for the onboarding model picker, plus their plan/codex
// aliases (e.g. openai -> openai-codex). Providers flagged `onboarding: false`
// (audio-only, e.g. deepgram) are excluded.
const onboardingProviderIds = (table = kDefaultTable) => {
  const ids = new Set();
  for (const entry of table) {
    if (entry.onboarding === false) continue;
    ids.add(entry.id);
    for (const variant of entry.onboardingVariants || []) ids.add(variant);
  }
  return ids;
};

// Entries shaped exactly like the provider entries in constants.kKnownVars,
// so they can be spread straight into that array (drives the env-var UI).
const providerKnownVars = (table = kDefaultTable) =>
  table.map((entry) => {
    const known = {
      key: entry.envVar,
      label: entry.label,
      group: entry.group || "ai",
    };
    if (entry.hint) known.hint = entry.hint;
    known.features = entry.features || ["Models"];
    return known;
  });

// Explicit config-path -> env-var map for the import secret detector, shaped
// like the provider rows of kConfigPathToEnvVar.
const secretDetectorEntries = (table = kDefaultTable) => {
  const out = {};
  for (const entry of table) {
    out[`models.providers.${entry.id}.apiKey`] = entry.envVar;
  }
  return out;
};

// Providers that ship a gateway config block (plugin-less providers, e.g. glm).
const providersWithGatewayConfig = (table = kDefaultTable) =>
  table.filter((entry) => entry.gatewayProvider);

module.exports = {
  listProviders,
  getProvider,
  apiKeyEnvVarByProvider,
  onboardingProviderIds,
  providerKnownVars,
  secretDetectorEntries,
  providersWithGatewayConfig,
};
