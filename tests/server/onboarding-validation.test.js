const { validateOnboardingInput } = require("../../lib/server/onboarding/validation");

const kBaseVars = () => [
  { key: "GITHUB_TOKEN", value: "ghp_test" },
  { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
  { key: "TELEGRAM_BOT_TOKEN", value: "telegram_tok" },
];

const kResolveProvider = (modelKey) => String(modelKey || "").split("/")[0] || "";

describe("onboarding/validation", () => {
  it("accepts OPENROUTER_API_KEY when the selected model uses the openrouter provider", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "OPENROUTER_API_KEY", value: "sk-or-test" }],
      modelKey: "openrouter/nvidia/nemotron-3-nano",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });

  it("accepts MOONSHOT_API_KEY when the selected model uses the moonshot provider", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "MOONSHOT_API_KEY", value: "sk-moonshot" }],
      modelKey: "moonshot/kimi-k2-5",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });

  it("rejects openrouter model when only unrelated API keys are present", () => {
    const res = validateOnboardingInput({
      vars: [...kBaseVars(), { key: "MOONSHOT_API_KEY", value: "sk-ms" }],
      modelKey: "openrouter/foo/bar",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Missing credentials for selected provider "openrouter"');
  });

  it("accepts onboarding without github vars in body when readEnvFile provides them", () => {
    const res = validateOnboardingInput({
      vars: [
        { key: "OPENAI_API_KEY", value: "sk-test-123" },
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_tok" },
      ],
      modelKey: "openai/gpt-5.1-codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
      readEnvFile: () => [
        { key: "GITHUB_TOKEN", value: "ghp_env_token" },
        { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.data.githubToken).toBe("ghp_env_token");
    expect(res.data.githubRepoInput).toBe("owner/repo");
  });

  it("rejects when github vars are absent from both submitted vars and env file", () => {
    const res = validateOnboardingInput({
      vars: [
        { key: "OPENAI_API_KEY", value: "sk-test-123" },
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_tok" },
      ],
      modelKey: "openai/gpt-5.1-codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
      readEnvFile: () => [],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("GitHub token and workspace repo are required");
  });

  it("prefers submitted vars over env file values for github vars", () => {
    const res = validateOnboardingInput({
      vars: [
        { key: "GITHUB_TOKEN", value: "ghp_submitted" },
        { key: "GITHUB_WORKSPACE_REPO", value: "submitted/repo" },
        { key: "OPENAI_API_KEY", value: "sk-test-123" },
        { key: "TELEGRAM_BOT_TOKEN", value: "telegram_tok" },
      ],
      modelKey: "openai/gpt-5.1-codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
      readEnvFile: () => [
        { key: "GITHUB_TOKEN", value: "ghp_env" },
        { key: "GITHUB_WORKSPACE_REPO", value: "env/repo" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.data.githubToken).toBe("ghp_submitted");
    expect(res.data.githubRepoInput).toBe("submitted/repo");
  });

  it("accepts whatsapp owner number as the required channel credential", () => {
    const res = validateOnboardingInput({
      vars: [
        { key: "GITHUB_TOKEN", value: "ghp_test" },
        { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
        { key: "WHATSAPP_OWNER_NUMBER", value: "+15551234567" },
        { key: "OPENAI_API_KEY", value: "sk-test-123" },
      ],
      modelKey: "openai/gpt-5.1-codex",
      resolveModelProvider: kResolveProvider,
      hasCodexOauthProfile: () => false,
    });
    expect(res.ok).toBe(true);
  });
});
