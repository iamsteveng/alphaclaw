const registryFile = require("../../lib/shared/model-providers.json");
const registry = registryFile.providers;
const {
  listProviders,
  getProvider,
  apiKeyEnvVarByProvider,
  onboardingProviderIds,
  providerKnownVars,
  secretDetectorEntries,
  providersWithGatewayConfig,
  unmanagedProviderIds,
  variantAliasMap,
} = require("../../lib/server/model-providers");

describe("provider registry schema", () => {
  it("is an object with providers[] and unmanagedProviders[] arrays", () => {
    expect(Array.isArray(registryFile.providers)).toBe(true);
    expect(Array.isArray(registryFile.unmanagedProviders)).toBe(true);
  });

  it("has the 23 seeded providers", () => {
    expect(listProviders()).toHaveLength(23);
  });

  it("unmanagedProviders are unique and do not overlap registry ids", () => {
    const unmanaged = registryFile.unmanagedProviders;
    expect(new Set(unmanaged).size).toBe(unmanaged.length);
    const registryIds = new Set(registry.map((e) => e.id));
    for (const id of unmanaged) {
      expect(typeof id).toBe("string");
      expect(id).toBeTruthy();
      expect(registryIds.has(id)).toBe(false);
    }
  });

  it("unmanagedProviderIds() returns the declared unmanaged ids as a Set", () => {
    const ids = unmanagedProviderIds();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has("amazon-bedrock")).toBe(true);
    expect(ids.has("ollama")).toBe(true);
    expect(ids.has("glm")).toBe(false); // glm is managed, not unmanaged
    expect(ids.size).toBe(registryFile.unmanagedProviders.length);
  });

  it("every entry carries id/envVar/label/group/features/authMethods", () => {
    for (const entry of registry) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id).toBeTruthy();
      expect(typeof entry.envVar).toBe("string");
      expect(entry.envVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(typeof entry.label).toBe("string");
      expect(entry.label).toBeTruthy();
      expect(typeof entry.group).toBe("string");
      expect(entry.group).toBeTruthy();
      expect(Array.isArray(entry.features)).toBe(true);
      expect(entry.features.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.authMethods)).toBe(true);
      expect(entry.authMethods.length).toBeGreaterThan(0);
      for (const method of entry.authMethods) {
        expect(["api-key", "oauth"]).toContain(method);
      }
    }
  });

  it("ids are unique", () => {
    const ids = registry.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("envVars are unique", () => {
    const envVars = registry.map((e) => e.envVar);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it("openai and anthropic support both api-key and oauth; everyone else api-key only", () => {
    for (const entry of registry) {
      if (entry.id === "openai" || entry.id === "anthropic") {
        expect(entry.authMethods).toEqual(["api-key", "oauth"]);
      } else {
        expect(entry.authMethods).toEqual(["api-key"]);
      }
    }
  });

  it("only glm ships a gatewayProvider block, matching the legacy glm config", () => {
    const withGateway = providersWithGatewayConfig();
    expect(withGateway.map((e) => e.id)).toEqual(["glm"]);
    const glm = getProvider("glm").gatewayProvider;
    expect(glm.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(glm.apiKey).toBe("${GLM_API_KEY}");
    expect(glm.api).toBe("openai-completions");
    expect(glm.models).toHaveLength(24);
  });
});

describe("accessor derivations reproduce the legacy hardcoded lists", () => {
  it("apiKeyEnvVarByProvider matches the old auth-profiles map", () => {
    const map = apiKeyEnvVarByProvider();
    expect(map.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(map.google).toBe("GEMINI_API_KEY");
    expect(map["vercel-ai-gateway"]).toBe("AI_GATEWAY_API_KEY");
    expect(map.volcengine).toBe("VOLCANO_ENGINE_API_KEY");
    expect(map["kimi-coding"]).toBe("KIMI_API_KEY");
    expect(Object.keys(map)).toHaveLength(23);
  });

  it("onboardingProviderIds includes the plan/codex variants and excludes audio-only providers", () => {
    const ids = onboardingProviderIds();
    expect(ids.has("openai-codex")).toBe(true);
    expect(ids.has("volcengine-plan")).toBe(true);
    expect(ids.has("byteplus-plan")).toBe(true);
    expect(ids.has("deepgram")).toBe(false); // audio-only, onboarding: false
    expect(ids.has("glm")).toBe(true);
    expect(ids.has("deepseek")).toBe(true);
    expect(ids.size).toBe(25);
  });

  it("variantAliasMap inverts onboardingVariants to exactly the three shipped pairs", () => {
    expect(variantAliasMap()).toEqual({
      "openai-codex": "openai",
      "volcengine-plan": "volcengine",
      "byteplus-plan": "byteplus",
    });
  });

  it("providerKnownVars reproduces the GLM env-var UI entry exactly", () => {
    const glm = providerKnownVars().find((v) => v.key === "GLM_API_KEY");
    expect(glm).toEqual({
      key: "GLM_API_KEY",
      label: "GLM API Key",
      group: "ai",
      hint: "From open.bigmodel.cn",
      features: ["Models"],
    });
  });

  it("secretDetectorEntries maps every provider apiKey config path to its env var", () => {
    const entries = secretDetectorEntries();
    expect(entries["models.providers.google.apiKey"]).toBe("GEMINI_API_KEY");
    expect(entries["models.providers.glm.apiKey"]).toBe("GLM_API_KEY");
    expect(entries["models.providers.deepseek.apiKey"]).toBe("DEEPSEEK_API_KEY");
    expect(Object.keys(entries)).toHaveLength(23);
  });
});

describe("adding one registry entry surfaces everywhere (table-driven)", () => {
  const synthetic = [
    ...registry,
    {
      id: "fictional",
      envVar: "FICTIONAL_API_KEY",
      label: "Fictional API Key",
      group: "ai",
      features: ["Models"],
      authMethods: ["api-key"],
    },
  ];

  it("a synthetic entry's onboardingVariants surface as inverse alias pairs", () => {
    const withVariant = [
      ...registry,
      {
        id: "fictional",
        envVar: "FICTIONAL_API_KEY",
        label: "Fictional API Key",
        group: "ai",
        features: ["Models"],
        authMethods: ["api-key"],
        onboardingVariants: ["fictional-plan", "fictional-codex"],
      },
    ];
    const map = variantAliasMap(withVariant);
    expect(map["fictional-plan"]).toBe("fictional");
    expect(map["fictional-codex"]).toBe("fictional");
  });

  it("appears in apiKeyEnvVarByProvider", () => {
    expect(apiKeyEnvVarByProvider(synthetic).fictional).toBe("FICTIONAL_API_KEY");
  });

  it("appears in onboardingProviderIds", () => {
    expect(onboardingProviderIds(synthetic).has("fictional")).toBe(true);
  });

  it("appears in providerKnownVars", () => {
    const entry = providerKnownVars(synthetic).find(
      (v) => v.key === "FICTIONAL_API_KEY",
    );
    expect(entry).toEqual({
      key: "FICTIONAL_API_KEY",
      label: "Fictional API Key",
      group: "ai",
      features: ["Models"],
    });
  });

  it("appears in secretDetectorEntries", () => {
    expect(secretDetectorEntries(synthetic)["models.providers.fictional.apiKey"]).toBe(
      "FICTIONAL_API_KEY",
    );
  });
});
