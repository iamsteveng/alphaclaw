import { describe, it, expect } from "vitest";
import golden from "./__fixtures__/model-config-golden.json";
import {
  kProviderAuthFields,
  kProviderLabels,
  kProviderOrder,
  kProviderFeatures,
  kAllAiAuthFields,
  getVisibleAiFieldKeys,
  getAuthProviderFromModelProvider,
  buildProviderAuthFields,
  buildProviderLabels,
  buildProviderOrder,
  buildProviderFeatures,
} from "../../lib/public/js/lib/model-config.js";

// The golden fixture was generated from the hand-maintained maps immediately
// before they were derived from the Provider Registry. Byte-identical output is
// the contract: deriving must not change what the UI renders.
describe("model-config derives the four provider maps from the Provider Registry", () => {
  it("kProviderAuthFields matches the pre-derivation golden exactly", () => {
    expect(kProviderAuthFields).toEqual(golden.kProviderAuthFields);
  });

  it("kProviderLabels matches the pre-derivation golden exactly", () => {
    expect(kProviderLabels).toEqual(golden.kProviderLabels);
  });

  it("kProviderOrder matches the pre-derivation golden exactly", () => {
    expect(kProviderOrder).toEqual(golden.kProviderOrder);
  });

  it("kProviderFeatures matches the pre-derivation golden exactly", () => {
    expect(kProviderFeatures).toEqual(golden.kProviderFeatures);
  });

  it("anthropic keeps both auth fields including the setup token", () => {
    const keys = kProviderAuthFields.anthropic.map((f) => f.key);
    expect(keys).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"]);
  });

  it("openai-codex still shows no api-key fields (OAuth path)", () => {
    expect(getVisibleAiFieldKeys("openai-codex").size).toBe(0);
  });

  it("variant aliases derive from the registry's onboardingVariants", () => {
    expect(getAuthProviderFromModelProvider("openai-codex")).toBe("openai");
    expect(getAuthProviderFromModelProvider("volcengine-plan")).toBe("volcengine");
    expect(getAuthProviderFromModelProvider("byteplus-plan")).toBe("byteplus");
    expect(getAuthProviderFromModelProvider("deepseek")).toBe("deepseek");
  });

  it("kAllAiAuthFields stays deduplicated by key", () => {
    const keys = kAllAiAuthFields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("builders are generic over the registry table", () => {
  const synthetic = [
    {
      id: "acme",
      envVar: "ACME_API_KEY",
      label: "Acme API Key",
      group: "ai",
      features: ["Models", "TTS"],
      authMethods: ["api-key"],
      displayLabel: "Acme AI",
      ui: {
        placeholder: "acme-...",
        url: "https://console.acme.dev",
        linkText: "Get key",
      },
    },
  ];

  it("a synthetic entry surfaces in all four derivations without editing model-config", () => {
    expect(buildProviderAuthFields(synthetic).acme).toEqual([
      {
        key: "ACME_API_KEY",
        label: "Acme API Key",
        url: "https://console.acme.dev",
        linkText: "Get key",
        placeholder: "acme-...",
      },
    ]);
    expect(buildProviderLabels(synthetic).acme).toBe("Acme AI");
    expect(buildProviderOrder(synthetic)).toEqual(["acme"]);
    // feature vocabulary mapping: Models -> Agent Model, TTS/STT -> Audio
    expect(buildProviderFeatures(synthetic).acme).toEqual(["Agent Model", "Audio"]);
  });

  it("extraAuthFields append after the derived api-key field", () => {
    const withExtra = [
      {
        ...synthetic[0],
        ui: {
          ...synthetic[0].ui,
          extraAuthFields: [
            { key: "ACME_TOKEN", label: "Acme Token", placeholder: "tok-..." },
          ],
        },
      },
    ];
    expect(buildProviderAuthFields(withExtra).acme.map((f) => f.key)).toEqual([
      "ACME_API_KEY",
      "ACME_TOKEN",
    ]);
  });
});
