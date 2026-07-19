// The Provider Registry (lib/shared/model-providers.json) is the single table
// that owns Model Provider identity — the provider maps in this module derive
// from it. Do not hand-edit provider entries here; change the registry.
import registry from "../../../shared/model-providers.json";

const kRegistryProviders = registry.providers;

export const getModelProvider = (modelKey) => String(modelKey || "").split("/")[0] || "";

// Variant aliases (openai-codex → openai, …) derive from the registry's
// onboardingVariants — same source the server's variantAliasMap() uses.
const kVariantToBaseProvider = Object.fromEntries(
  kRegistryProviders.flatMap((entry) =>
    (entry.onboardingVariants || []).map((variant) => [variant, entry.id]),
  ),
);

export const getAuthProviderFromModelProvider = (provider) => {
  const normalized = String(provider || "").trim();
  return kVariantToBaseProvider[normalized] || normalized;
};

// Whether a Model Provider supports the oauth Auth Method, per the registry.
export const providerHasOAuth = (provider) =>
  (
    kRegistryProviders.find((entry) => entry.id === provider)?.authMethods || []
  ).includes("oauth");

export const kFeaturedModelDefs = [
  {
    label: "Opus 4.7",
    preferredKeys: ["anthropic/claude-opus-4-7"],
  },
  {
    label: "Opus 4.6",
    preferredKeys: ["anthropic/claude-opus-4-6"],
  },
  {
    label: "Sonnet 4.6",
    preferredKeys: ["anthropic/claude-sonnet-4-6"],
  },
  {
    label: "Codex 5.3",
    preferredKeys: ["openai-codex/gpt-5.3-codex"],
  },
  {
    label: "GPT-5.5",
    preferredKeys: ["openai-codex/gpt-5.5"],
  },
  {
    label: "Gemini 3.1 Pro",
    preferredKeys: ["google/gemini-3.1-pro-preview"],
  },
];

export const getFeaturedModels = (allModels) => {
  const picked = [];
  const used = new Set();
  kFeaturedModelDefs.forEach((def) => {
    const found = def.preferredKeys
      .map((key) => allModels.find((model) => model.key === key))
      .find(Boolean);
    if (!found || used.has(found.key)) return;
    picked.push({ ...found, featuredLabel: def.label });
    used.add(found.key);
  });
  return picked;
};

// ---------------------------------------------------------------------------
// The four provider maps below derive from the Provider Registry. Registry
// array order is the canonical UI order.
// ---------------------------------------------------------------------------

// Registry `features` speak the env-var UI vocabulary (Models/Embeddings/
// TTS/STT/Audio); the model-settings UI speaks Agent Model/Embeddings/Audio.
const kFeatureTagByRegistryFeature = {
  Models: "Agent Model",
  Embeddings: "Embeddings",
  TTS: "Audio",
  STT: "Audio",
  Audio: "Audio",
};

export const buildProviderAuthFields = (providers = kRegistryProviders) =>
  Object.fromEntries(
    providers.map((entry) => {
      const ui = entry.ui || {};
      const primary = {
        key: entry.envVar,
        label: entry.label,
        ...(ui.url ? { url: ui.url } : {}),
        ...(ui.linkText ? { linkText: ui.linkText } : {}),
        ...(ui.placeholder ? { placeholder: ui.placeholder } : {}),
      };
      // NOTE: a registry entry's top-level `hint` feeds the env-var settings
      // UI (server providerKnownVars()), not these auth fields. Auth-field
      // hints belong on ui.extraAuthFields entries (see anthropic).
      return [entry.id, [primary, ...(ui.extraAuthFields || [])]];
    }),
  );

export const buildProviderLabels = (providers = kRegistryProviders) =>
  Object.fromEntries(providers.map((entry) => [entry.id, entry.displayLabel]));

export const buildProviderOrder = (providers = kRegistryProviders) =>
  providers.map((entry) => entry.id);

export const buildProviderFeatures = (providers = kRegistryProviders) =>
  Object.fromEntries(
    providers.map((entry) => [
      entry.id,
      [
        ...new Set(
          (entry.features || [])
            .map((feature) => kFeatureTagByRegistryFeature[feature])
            .filter(Boolean),
        ),
      ],
    ]),
  );

export const kProviderAuthFields = buildProviderAuthFields();

export const kProviderLabels = buildProviderLabels();

export const kProviderOrder = buildProviderOrder();

export const kProviderFeatures = buildProviderFeatures();

export const kCoreProviders = new Set(["anthropic", "openai", "google", "openrouter"]);

export const kFeatureDefs = [
  {
    id: "embeddings",
    label: "Memory Embeddings",
    tag: "Embeddings",
    providers: ["openai", "google", "voyage", "mistral"],
  },
  {
    id: "audio",
    label: "Audio Transcription",
    tag: "Audio",
    hasDefault: true,
    providers: ["openai", "groq", "deepgram", "google", "mistral"],
  },
];

export const getVisibleAiFieldKeys = (provider) => {
  if (provider === "openai-codex") return new Set();
  const authProvider = getAuthProviderFromModelProvider(provider);
  const fields = kProviderAuthFields[authProvider] || [];
  return new Set(fields.map((field) => field.key));
};

export const kAllAiAuthFields = Object.values(kProviderAuthFields)
  .flat()
  .filter((field, idx, arr) => arr.findIndex((item) => item.key === field.key) === idx);
