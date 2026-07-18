import { describe, it, expect } from "vitest";
import { getProviderMeta } from "../../lib/public/js/components/models-tab/provider-auth-card.js";
import { providerHasOAuth } from "../../lib/public/js/lib/model-config.js";

// The auth card's field data (labels, urls, placeholders, hints) derives from
// the Provider Registry via kProviderAuthFields; only mode structure (tab
// labels, profile suffixes, field kinds, OAuth flows) stays bespoke.
describe("provider-auth-card meta derives field data from the registry", () => {
  it("anthropic: api-key mode carries registry field data, bespoke tab label", () => {
    const meta = getProviderMeta("anthropic");
    expect(meta.label).toBe("Anthropic");
    const [apiKey, token] = meta.modes;
    expect(apiKey).toMatchObject({
      id: "api_key",
      label: "API Key",
      profileSuffix: "default",
      placeholder: "sk-ant-api03-...",
      url: "https://console.anthropic.com",
      field: "key",
    });
    expect(token).toMatchObject({
      id: "token",
      label: "Setup Token",
      profileSuffix: "manual",
      placeholder: "sk-ant-oat01-...",
      hint: "From claude setup-token (uses your Claude subscription)",
      field: "token",
    });
  });

  it("openai: registry api-key mode plus Codex OAuth gated on authMethods", () => {
    const meta = getProviderMeta("openai");
    expect(meta.label).toBe("OpenAI");
    expect(meta.modes[0]).toMatchObject({
      id: "api_key",
      placeholder: "sk-...",
      url: "https://platform.openai.com",
      field: "key",
    });
    expect(meta.modes[1]).toMatchObject({ id: "oauth", isCodexOauth: true });
  });

  it("google: single registry-derived api-key mode", () => {
    const meta = getProviderMeta("google");
    expect(meta.label).toBe("Gemini");
    expect(meta.modes).toHaveLength(1);
    expect(meta.modes[0]).toMatchObject({
      placeholder: "AI...",
      url: "https://aistudio.google.com",
      field: "key",
    });
  });

  it("pseudo-providers keep their bespoke OAuth-only modes", () => {
    expect(getProviderMeta("openai-codex").modes).toEqual([
      expect.objectContaining({ id: "oauth", isCodexOauth: true }),
    ]);
    expect(getProviderMeta("claude-code").modes).toEqual([
      expect.objectContaining({ id: "oauth", isClaudeCodeOauth: true }),
    ]);
  });

  it("plain providers keep the registry-derived default path", () => {
    const meta = getProviderMeta("deepseek");
    expect(meta.label).toBe("DeepSeek");
    expect(meta.modes[0]).toMatchObject({
      placeholder: "sk-...",
      url: "https://platform.deepseek.com",
      field: "key",
    });
  });
});

describe("providerHasOAuth derives from registry authMethods", () => {
  it("openai and anthropic have OAuth; api-key-only providers do not", () => {
    expect(providerHasOAuth("openai")).toBe(true);
    expect(providerHasOAuth("anthropic")).toBe(true);
    expect(providerHasOAuth("deepseek")).toBe(false);
    expect(providerHasOAuth("nonexistent")).toBe(false);
  });
});
