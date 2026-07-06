const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ensureGlmProviderEntry,
  ensureGlmProviderConfig,
  GLM_BASE_URL,
} = require("../../lib/server/glm-provider-config");

describe("server/glm-provider-config", () => {
  describe("ensureGlmProviderEntry", () => {
    it("adds the glm provider block to an empty config", () => {
      const cfg = {};
      const changed = ensureGlmProviderEntry(cfg);

      expect(changed).toBe(true);
      expect(cfg.models.providers.glm.baseUrl).toBe(GLM_BASE_URL);
      expect(cfg.models.providers.glm.apiKey).toBe("${GLM_API_KEY}");
      expect(cfg.models.providers.glm.api).toBe("openai-completions");
      expect(cfg.models.providers.glm.models.length).toBe(24);
    });

    it("preserves unrelated config keys", () => {
      const cfg = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        models: { providers: { zai: { baseUrl: "https://api.z.ai" } } },
      };
      ensureGlmProviderEntry(cfg);

      expect(cfg.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-6");
      expect(cfg.models.providers.zai.baseUrl).toBe("https://api.z.ai");
      expect(cfg.models.providers.glm.baseUrl).toBe(GLM_BASE_URL);
    });

    it("is idempotent — reports no change on a second call with identical content", () => {
      const cfg = {};
      ensureGlmProviderEntry(cfg);
      const changed = ensureGlmProviderEntry(cfg);

      expect(changed).toBe(false);
    });
  });

  describe("ensureGlmProviderConfig", () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-glm-provider-config-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes models.providers.glm into openclaw.json even with no glm credential yet", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
      );

      const changed = ensureGlmProviderConfig({ fsModule: fs, openclawDir });
      expect(changed).toBe(true);

      const config = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(config.models.providers.glm.baseUrl).toBe(GLM_BASE_URL);
      expect(config.agents.defaults.model.primary).toBe(
        "anthropic/claude-opus-4-6",
      );
    });

    it("does not rewrite the file when already up to date", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({}));

      ensureGlmProviderConfig({ fsModule: fs, openclawDir });
      const changed = ensureGlmProviderConfig({ fsModule: fs, openclawDir });

      expect(changed).toBe(false);
    });
  });
});
