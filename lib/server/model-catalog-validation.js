const {
  listProviders,
  unmanagedProviderIds,
  variantAliasMap,
} = require("./model-providers");

// Distinct provider ids referenced by a model catalog. Prefers the explicit
// `provider` field; falls back to the "provider/model" key prefix.
const catalogProviderIds = (catalog) => {
  const ids = new Set();
  for (const model of catalog?.models || []) {
    const provider =
      model?.provider || String(model?.key || "").split("/")[0] || "";
    if (provider) ids.add(provider);
  }
  return ids;
};

// Catalog provider ids (alias-resolved) that are neither a managed Provider
// Registry entry nor declared in `unmanagedProviders`. Pure — returns a
// deduped, sorted array. `table` overrides the default registry and
// `unmanaged` the default unmanaged list, both for tests.
const findOrphanCatalogProviders = ({ catalog, table, unmanaged } = {}) => {
  const registryIds = new Set(listProviders(table).map((entry) => entry.id));
  const unmanagedIds = unmanagedProviderIds(unmanaged);
  const aliases = variantAliasMap(table);
  const orphans = new Set();
  for (const provider of catalogProviderIds(catalog)) {
    const base = aliases[provider] || provider;
    if (registryIds.has(base)) continue;
    if (unmanagedIds.has(provider) || unmanagedIds.has(base)) continue;
    orphans.add(provider);
  }
  return [...orphans].sort();
};

// Boot-time consistency check: catalog providers with no registry entry are
// silently dropped from the onboarding picker (normalizeOnboardingModels filters
// on onboardingProviderIds()), so surface them loudly. Never throws/crashes.
const validateCatalogProviderRegistry = ({ catalog, table, unmanaged, logger = console } = {}) => {
  const orphans = findOrphanCatalogProviders({ catalog, table, unmanaged });
  if (orphans.length) {
    logger.error(
      `[alphaclaw] Model catalog references provider id(s) with no Provider Registry entry: ${orphans.join(", ")}. ` +
        "Add each to lib/shared/model-providers.json (or map it to a base provider via a variant alias) — " +
        "until then their models are silently dropped from the onboarding model picker.",
    );
  }
  return orphans;
};

module.exports = {
  findOrphanCatalogProviders,
  validateCatalogProviderRegistry,
  catalogProviderIds,
};
