const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  syncGatewayProviders,
  ensureGatewayProviderConfig,
} = require("../../lib/server/gateway-provider-config");
const {
  providersWithGatewayConfig,
} = require("../../lib/server/model-providers");

// A synthetic second gateway-provider entry, injected via the accessor's
// optional `table` param, to prove the writer is generic and not hardwired
// to glm.
const kSyntheticEntry = {
  id: "acme",
  envVar: "ACME_API_KEY",
  label: "Acme API Key",
  group: "ai",
  gatewayProvider: {
    baseUrl: "https://acme.test/v1",
    apiKey: "${ACME_API_KEY}",
    api: "openai-completions",
    models: [{ id: "acme-1", name: "Acme 1" }],
  },
};

const registryEntries = providersWithGatewayConfig();
const syntheticTable = [
  ...require("../../lib/shared/model-providers.json").providers,
  kSyntheticEntry,
];

describe("server/gateway-provider-config", () => {
  describe("syncGatewayProviders — table-driven over every registry gateway entry", () => {
    // Iterate the registry so any future entry with a gatewayProvider block is
    // covered automatically without editing this test.
    for (const entry of registryEntries) {
      describe(`provider "${entry.id}"`, () => {
        const hasNone = () => false;
        const hasThis = (envVar) => envVar === entry.envVar;

        it("writes no block and removes a stale block when the env value is absent", () => {
          const config = {
            models: {
              providers: {
                [entry.id]: { baseUrl: "stale", apiKey: entry.gatewayProvider.apiKey },
                zai: { baseUrl: "https://api.z.ai" },
              },
            },
          };
          const changed = syncGatewayProviders({ config, hasEnvValue: hasNone });

          expect(changed).toBe(true);
          expect(config.models.providers[entry.id]).toBeUndefined();
          // Unrelated providers are preserved.
          expect(config.models.providers.zai.baseUrl).toBe("https://api.z.ai");
        });

        it("is a no-op when env value is absent and no block exists", () => {
          const config = {};
          const changed = syncGatewayProviders({ config, hasEnvValue: hasNone });

          expect(changed).toBe(false);
          expect(config.models?.providers?.[entry.id]).toBeUndefined();
        });

        it("writes the block exactly matching the registry data when the env value is present", () => {
          const config = {
            agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
          };
          const changed = syncGatewayProviders({ config, hasEnvValue: hasThis });

          expect(changed).toBe(true);
          expect(config.models.providers[entry.id]).toEqual(entry.gatewayProvider);
          // Deep clone — mutating the config must not mutate the registry.
          config.models.providers[entry.id].baseUrl = "mutated";
          expect(entry.gatewayProvider.baseUrl).not.toBe("mutated");
          // Unrelated config preserved.
          expect(config.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-6");
        });

        it("is idempotent — a second call with the same inputs reports no change", () => {
          const config = {};
          syncGatewayProviders({ config, hasEnvValue: hasThis });
          const changed = syncGatewayProviders({ config, hasEnvValue: hasThis });

          expect(changed).toBe(false);
          expect(config.models.providers[entry.id]).toEqual(entry.gatewayProvider);
        });
      });
    }
  });

  describe("syncGatewayProviders — generic over a synthetic second entry", () => {
    it("writes the synthetic provider block when its env value is present", () => {
      const config = {};
      const changed = syncGatewayProviders({
        config,
        table: syntheticTable,
        hasEnvValue: (envVar) => envVar === "ACME_API_KEY",
      });

      expect(changed).toBe(true);
      expect(config.models.providers.acme).toEqual(kSyntheticEntry.gatewayProvider);
    });

    it("removes a stale synthetic block when its env value is absent", () => {
      const config = {
        models: { providers: { acme: { baseUrl: "stale" } } },
      };
      const changed = syncGatewayProviders({
        config,
        table: syntheticTable,
        hasEnvValue: () => false,
      });

      expect(changed).toBe(true);
      expect(config.models.providers.acme).toBeUndefined();
    });

    it("syncs multiple gateway providers in one pass", () => {
      const config = {};
      const changed = syncGatewayProviders({
        config,
        table: syntheticTable,
        // both glm and acme present
        hasEnvValue: (envVar) => envVar === "GLM_API_KEY" || envVar === "ACME_API_KEY",
      });

      expect(changed).toBe(true);
      expect(config.models.providers.glm.baseUrl).toBe(
        "https://open.bigmodel.cn/api/paas/v4",
      );
      expect(config.models.providers.acme).toEqual(kSyntheticEntry.gatewayProvider);
    });
  });

  describe("ensureGatewayProviderConfig — fs wrapper", () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-gateway-provider-config-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const hasGlm = (envVar) => envVar === "GLM_API_KEY";
    const hasNone = () => false;

    it("does not write a provider block when no credential/env value is present", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
      );

      const changed = ensureGatewayProviderConfig({ fsModule: fs, openclawDir, hasEnvValue: hasNone });
      expect(changed).toBe(false);

      const config = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(config.models?.providers?.glm).toBeUndefined();
    });

    it("writes the provider block into openclaw.json once the env value exists", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
      );

      const changed = ensureGatewayProviderConfig({ fsModule: fs, openclawDir, hasEnvValue: hasGlm });
      expect(changed).toBe(true);

      const config = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(config.models.providers.glm.baseUrl).toBe(
        "https://open.bigmodel.cn/api/paas/v4",
      );
      expect(config.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-6");
    });

    it("removes a previously-written block once the env value is gone", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({}));

      ensureGatewayProviderConfig({ fsModule: fs, openclawDir, hasEnvValue: hasGlm });
      const changed = ensureGatewayProviderConfig({ fsModule: fs, openclawDir, hasEnvValue: hasNone });
      expect(changed).toBe(true);

      const config = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(config.models?.providers?.glm).toBeUndefined();
    });

    it("does not rewrite the file when already up to date", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({}));

      ensureGatewayProviderConfig({ fsModule: fs, openclawDir, hasEnvValue: hasGlm });
      const changed = ensureGatewayProviderConfig({ fsModule: fs, openclawDir, hasEnvValue: hasGlm });

      expect(changed).toBe(false);
    });
  });
});
