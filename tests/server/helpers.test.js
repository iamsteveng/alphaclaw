const {
  parseJsonFromNoisyOutput,
  parseJwtPayload,
  getCodexAccountId,
  resolveGithubRepoUrl,
  normalizeOnboardingModels,
  normalizeCodexModelKey,
  normalizeCodexConfiguredModels,
} = require("../../lib/server/helpers");
const { CODEX_JWT_CLAIM_PATH } = require("../../lib/server/constants");

const makeJwt = (payload) => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
};

describe("server/helpers", () => {
  it("parses JSON from noisy command output", () => {
    const value = parseJsonFromNoisyOutput('log line\n{"ok":true,"count":2}\nextra');
    expect(value).toEqual({ ok: true, count: 2 });
  });

  it("returns null when noisy output has no valid JSON", () => {
    expect(parseJsonFromNoisyOutput("no braces here")).toBeNull();
    expect(parseJsonFromNoisyOutput("start {bad json} end")).toBeNull();
  });

  it("normalizes GitHub repository URLs and shorthands", () => {
    expect(resolveGithubRepoUrl("owner/repo")).toBe("owner/repo");
    expect(resolveGithubRepoUrl("git@github.com:owner/repo.git")).toBe("owner/repo");
    expect(resolveGithubRepoUrl("https://github.com/owner/repo")).toBe("owner/repo");
  });

  it("throws when repo input is not owner/repo format", () => {
    expect(() => resolveGithubRepoUrl("just-owner")).toThrow(
      'GITHUB_WORKSPACE_REPO must be in "owner/repo" format.',
    );
  });

  it("parses JWT payload and extracts Codex account id", () => {
    const token = makeJwt({
      [CODEX_JWT_CLAIM_PATH]: { chatgpt_account_id: "acct_123" },
      sub: "abc",
    });

    const payload = parseJwtPayload(token);
    expect(payload.sub).toBe("abc");
    expect(getCodexAccountId(token)).toBe("acct_123");
  });

  it("returns null for invalid JWT payloads", () => {
    expect(parseJwtPayload("bad.token")).toBeNull();
    expect(getCodexAccountId("bad.token.value")).toBeNull();
  });

  it("normalizes onboarding models by filtering, deduping, and sorting", () => {
    const normalized = normalizeOnboardingModels([
      { key: "unknown/model-a", name: "Ignore me" },
      { key: "openai/gpt-5.1-codex", name: "OpenAI A" },
      { key: "anthropic/claude-opus-4-6", name: "Opus 4.6" },
      { key: "zai/glm-5", name: "GLM 5" },
      { key: "minimax/MiniMax-M2.5", name: "MiniMax M2.5" },
      { key: "openai/gpt-5.1-codex", name: "Duplicate" },
      { key: "google/gemini-3.1-pro-preview" },
      { bad: "shape" },
    ]);

    expect(normalized).toEqual([
      {
        key: "anthropic/claude-opus-4-6",
        provider: "anthropic",
        label: "Opus 4.6",
      },
      {
        key: "google/gemini-3.1-pro-preview",
        provider: "google",
        label: "google/gemini-3.1-pro-preview",
      },
      {
        key: "minimax/MiniMax-M2.5",
        provider: "minimax",
        label: "MiniMax M2.5",
      },
      // openai-codex entries are always injected from the bootstrap catalog
      // (OpenClaw normalises live models to openai/ so they would otherwise disappear)
      { key: "openai-codex/gpt-5.1", provider: "openai-codex", label: "GPT-5.1" },
      { key: "openai-codex/gpt-5.1-codex-max", provider: "openai-codex", label: "GPT-5.1 Codex Max" },
      { key: "openai-codex/gpt-5.1-codex-mini", provider: "openai-codex", label: "GPT-5.1 Codex Mini" },
      { key: "openai-codex/gpt-5.2", provider: "openai-codex", label: "GPT-5.2" },
      { key: "openai-codex/gpt-5.2-codex", provider: "openai-codex", label: "GPT-5.2 Codex" },
      { key: "openai-codex/gpt-5.3-codex", provider: "openai-codex", label: "GPT-5.3 Codex" },
      { key: "openai-codex/gpt-5.3-codex-spark", provider: "openai-codex", label: "GPT-5.3 Codex Spark" },
      { key: "openai-codex/gpt-5.4", provider: "openai-codex", label: "GPT-5.4" },
      { key: "openai-codex/gpt-5.4-mini", provider: "openai-codex", label: "GPT-5.4 Mini" },
      { key: "openai-codex/gpt-5.5", provider: "openai-codex", label: "GPT-5.5" },
      {
        key: "openai/gpt-5.1-codex",
        provider: "openai",
        label: "OpenAI A",
      },
      {
        key: "zai/glm-5",
        provider: "zai",
        label: "GLM 5",
      },
    ]);
  });

  describe("normalizeCodexModelKey", () => {
    it("rewrites openai-codex/ prefix to openai/", () => {
      expect(normalizeCodexModelKey("openai-codex/gpt-5.4")).toBe("openai/gpt-5.4");
      expect(normalizeCodexModelKey("openai-codex/gpt-5.3-codex")).toBe("openai/gpt-5.3-codex");
    });

    it("leaves non-codex keys unchanged", () => {
      expect(normalizeCodexModelKey("openai/gpt-5.1-codex")).toBe("openai/gpt-5.1-codex");
      expect(normalizeCodexModelKey("anthropic/claude-opus-4-6")).toBe("anthropic/claude-opus-4-6");
    });

    it("handles non-string input", () => {
      expect(normalizeCodexModelKey(null)).toBeNull();
      expect(normalizeCodexModelKey(undefined)).toBeUndefined();
    });
  });

  describe("normalizeCodexConfiguredModels", () => {
    it("renames openai-codex/ keys to openai/ without injecting agentRuntime", () => {
      const result = normalizeCodexConfiguredModels({
        "openai-codex/gpt-5.4": {},
        "openai-codex/gpt-5.3-codex": { someOption: true },
        "anthropic/claude-opus-4-6": { other: 1 },
      });
      expect(result).toEqual({
        "openai/gpt-5.4": {},
        "openai/gpt-5.3-codex": { someOption: true },
        "anthropic/claude-opus-4-6": { other: 1 },
      });
    });

    it("preserves existing agentRuntime.id when present", () => {
      const result = normalizeCodexConfiguredModels({
        "openai-codex/gpt-5.4": { agentRuntime: { id: "codex" } },
      });
      expect(result["openai/gpt-5.4"].agentRuntime.id).toBe("codex");
    });

    it("returns the input unchanged when null or non-object", () => {
      expect(normalizeCodexConfiguredModels(null)).toBeNull();
      expect(normalizeCodexConfiguredModels(undefined)).toBeUndefined();
    });
  });
});
