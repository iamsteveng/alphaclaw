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
    it("does nothing when hasApiKey is false and no entry exists", () => {
      const cfg = {};
      const changed = ensureGlmProviderEntry(cfg, { hasApiKey: false });

      expect(changed).toBe(false);
      expect(cfg.models?.providers?.glm).toBeUndefined();
    });

    it("adds the glm provider block only when hasApiKey is true", () => {
      const cfg = {};
      const changed = ensureGlmProviderEntry(cfg, { hasApiKey: true });

      expect(changed).toBe(true);
      expect(cfg.models.providers.glm.baseUrl).toBe(GLM_BASE_URL);
      expect(cfg.models.providers.glm.apiKey).toBe("${GLM_API_KEY}");
      expect(cfg.models.providers.glm.api).toBe("openai-completions");
      expect(cfg.models.providers.glm.models.length).toBe(24);
    });

    // OpenClaw's gateway eagerly resolves every `${VAR}` secret ref in
    // openclaw.json at startup and hard-fails the whole gateway if one is
    // unresolvable — so a stale glm block from a prior credential removal
    // must not be left behind pointing at a now-missing GLM_API_KEY.
    it("removes an existing glm block when hasApiKey is false (self-heals a stale/broken entry)", () => {
      const cfg = {
        models: {
          providers: {
            glm: { baseUrl: GLM_BASE_URL, apiKey: "${GLM_API_KEY}", models: [] },
            zai: { baseUrl: "https://api.z.ai" },
          },
        },
      };
      const changed = ensureGlmProviderEntry(cfg, { hasApiKey: false });

      expect(changed).toBe(true);
      expect(cfg.models.providers.glm).toBeUndefined();
      expect(cfg.models.providers.zai.baseUrl).toBe("https://api.z.ai");
    });

    it("preserves unrelated config keys", () => {
      const cfg = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        models: { providers: { zai: { baseUrl: "https://api.z.ai" } } },
      };
      ensureGlmProviderEntry(cfg, { hasApiKey: true });

      expect(cfg.agents.defaults.model.primary).toBe("anthropic/claude-opus-4-6");
      expect(cfg.models.providers.zai.baseUrl).toBe("https://api.z.ai");
      expect(cfg.models.providers.glm.baseUrl).toBe(GLM_BASE_URL);
    });

    it("is idempotent — reports no change on a second call with identical content", () => {
      const cfg = {};
      ensureGlmProviderEntry(cfg, { hasApiKey: true });
      const changed = ensureGlmProviderEntry(cfg, { hasApiKey: true });

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

    it("does not write models.providers.glm when no glm credential is present", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
      );

      const changed = ensureGlmProviderConfig({ fsModule: fs, openclawDir, hasApiKey: false });
      expect(changed).toBe(false);

      const config = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(config.models?.providers?.glm).toBeUndefined();
    });

    it("writes models.providers.glm into openclaw.json once a glm credential exists", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
      );

      const changed = ensureGlmProviderConfig({ fsModule: fs, openclawDir, hasApiKey: true });
      expect(changed).toBe(true);

      const config = JSON.parse(
        fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"),
      );
      expect(config.models.providers.glm.baseUrl).toBe(GLM_BASE_URL);
      expect(config.agents.defaults.model.primary).toBe(
        "anthropic/claude-opus-4-6",
      );
    });

    it("removes a previously-written glm block once the credential is gone", () => {
      const openclawDir = path.join(tmpDir, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({}));

      ensureGlmProviderConfig({ fsModule: fs, openclawDir, hasApiKey: true });
      const changed = ensureGlmProviderConfig({ fsModule: fs, openclawDir, hasApiKey: false });
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

      ensureGlmProviderConfig({ fsModule: fs, openclawDir, hasApiKey: true });
      const changed = ensureGlmProviderConfig({ fsModule: fs, openclawDir, hasApiKey: true });

      expect(changed).toBe(false);
    });
  });
});
