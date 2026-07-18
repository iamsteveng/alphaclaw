const {
  findOrphanCatalogProviders,
  validateCatalogProviderRegistry,
} = require("../../lib/server/model-catalog-validation");
const kBootstrapModelCatalog = require("../../lib/server/model-catalog-bootstrap.json");

describe("server/model-catalog-validation", () => {
  describe("findOrphanCatalogProviders", () => {
    it("returns nothing for a catalog whose providers are all registered", () => {
      const catalog = {
        models: [
          { key: "anthropic/claude-opus-4-6", provider: "anthropic" },
          { key: "openai/gpt-5", provider: "openai" },
          { key: "glm/glm-5.2", provider: "glm" },
        ],
      };
      expect(findOrphanCatalogProviders({ catalog })).toEqual([]);
    });

    it("reports a provider id that is neither registered nor declared unmanaged", () => {
      const catalog = {
        models: [
          { key: "anthropic/claude-opus-4-6", provider: "anthropic" },
          { key: "acme/acme-1", provider: "acme" },
        ],
      };
      expect(findOrphanCatalogProviders({ catalog })).toEqual(["acme"]);
    });

    it("does not report ids declared in unmanagedProviders", () => {
      const catalog = {
        models: [
          { key: "amazon-bedrock/nova", provider: "amazon-bedrock" },
          { key: "ollama/llama3", provider: "ollama" },
          { key: "github-copilot/gpt", provider: "github-copilot" },
        ],
      };
      expect(findOrphanCatalogProviders({ catalog })).toEqual([]);
    });

    it("still reports an unknown id even when other unmanaged ids are present", () => {
      const catalog = {
        models: [
          { key: "ollama/llama3", provider: "ollama" }, // declared unmanaged
          { key: "acme/acme-1", provider: "acme" }, // genuinely orphaned
        ],
      };
      expect(findOrphanCatalogProviders({ catalog })).toEqual(["acme"]);
    });

    it("REGRESSION — the real bootstrap catalog produces no orphans (boot is silent)", () => {
      expect(
        findOrphanCatalogProviders({ catalog: kBootstrapModelCatalog }),
      ).toEqual([]);
    });

    it("resolves variant aliases to their base provider (not orphans)", () => {
      const catalog = {
        models: [
          { key: "openai-codex/gpt-5.3-codex", provider: "openai-codex" },
          { key: "volcengine-plan/x", provider: "volcengine-plan" },
          { key: "byteplus-plan/y", provider: "byteplus-plan" },
        ],
      };
      expect(findOrphanCatalogProviders({ catalog })).toEqual([]);
    });

    it("derives the provider id from the model key when provider field is missing", () => {
      const catalog = { models: [{ key: "acme/acme-1" }] };
      expect(findOrphanCatalogProviders({ catalog })).toEqual(["acme"]);
    });

    it("dedupes and sorts orphaned ids", () => {
      const catalog = {
        models: [
          { key: "zzz/a", provider: "zzz" },
          { key: "aaa/b", provider: "aaa" },
          { key: "zzz/c", provider: "zzz" },
        ],
      };
      expect(findOrphanCatalogProviders({ catalog })).toEqual(["aaa", "zzz"]);
    });

    it("honours a synthetic registry table (orphan becomes registered)", () => {
      const catalog = { models: [{ key: "acme/acme-1", provider: "acme" }] };
      const table = [{ id: "acme", envVar: "ACME_API_KEY" }];
      expect(findOrphanCatalogProviders({ catalog, table })).toEqual([]);
    });
  });

  describe("validateCatalogProviderRegistry", () => {
    it("logs a loud, actionable error listing orphaned ids", () => {
      const errors = [];
      const logger = { error: (msg) => errors.push(msg) };
      const catalog = {
        models: [
          { key: "anthropic/claude-opus-4-6", provider: "anthropic" },
          { key: "acme/acme-1", provider: "acme" },
        ],
      };
      const orphans = validateCatalogProviderRegistry({ catalog, logger });

      expect(orphans).toEqual(["acme"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("acme");
      expect(errors[0]).toContain("model-providers.json");
    });

    it("stays silent for a clean catalog", () => {
      const errors = [];
      const logger = { error: (msg) => errors.push(msg) };
      const catalog = {
        models: [{ key: "anthropic/claude-opus-4-6", provider: "anthropic" }],
      };
      const orphans = validateCatalogProviderRegistry({ catalog, logger });

      expect(orphans).toEqual([]);
      expect(errors).toHaveLength(0);
    });

    it("REGRESSION — stays silent against the real bootstrap catalog", () => {
      const errors = [];
      const logger = { error: (msg) => errors.push(msg) };
      const orphans = validateCatalogProviderRegistry({
        catalog: kBootstrapModelCatalog,
        logger,
      });

      expect(orphans).toEqual([]);
      expect(errors).toHaveLength(0);
    });
  });
});
