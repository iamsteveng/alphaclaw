const kBootstrapModelCatalog = require("../../lib/server/model-catalog-bootstrap.json");

// The bootstrap catalog is regenerated from a running instance's live model
// list (`/api/models`, i.e. `HOME=/data openclaw models list --all --json`
// inside the container), plus the openai-codex/ picker keys that OpenClaw
// normalises away. These invariants keep a hand-edit or a bad regeneration
// from shipping a catalog the onboarding UI cannot render.
describe("server/model-catalog-bootstrap.json", () => {
  const models = kBootstrapModelCatalog.models;

  it("carries the catalog envelope fields", () => {
    expect(kBootstrapModelCatalog.version).toBe(1);
    expect(typeof kBootstrapModelCatalog.source).toBe("string");
    expect(typeof kBootstrapModelCatalog.generatedAt).toBe("string");
    expect(typeof kBootstrapModelCatalog.openclawVersion).toBe("string");
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  });

  it("is sorted by key with no duplicates", () => {
    const keys = models.map((model) => model.key);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every entry a key, provider and label, with provider === key prefix", () => {
    for (const model of models) {
      expect(typeof model.key).toBe("string");
      expect(typeof model.provider).toBe("string");
      expect(typeof model.label).toBe("string");
      expect(model.label).not.toBe("");
      expect(model.key).toContain("/");
      expect(model.provider).toBe(model.key.split("/")[0]);
    }
  });

  // The welcome step preselects the first resolvable featured chip from the
  // bootstrap and never replaces it once MODEL_KEY is set, so the non-OpenAI
  // featured keys must be present or a fresh install preselects GPT-5.5.
  it("carries the featured non-OpenAI models so onboarding preselects Opus", () => {
    const byKey = new Map(models.map((model) => [model.key, model]));

    expect(byKey.get("anthropic/claude-opus-4-7")?.label).toBe(
      "Claude Opus 4.7",
    );
    expect(byKey.get("anthropic/claude-opus-4-6")?.label).toBe(
      "Claude Opus 4.6",
    );
    expect(byKey.get("anthropic/claude-sonnet-4-6")?.label).toBe(
      "Claude Sonnet 4.6",
    );
    expect(byKey.get("google/gemini-3.1-pro-preview")?.label).toBe(
      "Gemini 3.1 Pro Preview",
    );
  });

  it("carries the GPT-5.6 tiers under the openai-codex picker prefix", () => {
    const byKey = new Map(models.map((model) => [model.key, model]));

    expect(byKey.get("openai-codex/gpt-5.6-sol")?.label).toBe("GPT-5.6 Sol");
    expect(byKey.get("openai-codex/gpt-5.6-terra")?.label).toBe(
      "GPT-5.6 Terra",
    );
    expect(byKey.get("openai-codex/gpt-5.6-luna")?.label).toBe("GPT-5.6 Luna");
  });
});
