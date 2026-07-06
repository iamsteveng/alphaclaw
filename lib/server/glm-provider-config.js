const { readOpenclawConfig, writeOpenclawConfig } = require("./openclaw-config");

// `glm` has no bundled OpenClaw provider plugin (unlike `zai`), so this must be
// registered as a custom `models.providers.glm` entry for OpenClaw's own model
// catalog (`openclaw models list --all --json`) to know about it at all —
// otherwise it never appears in the Models tab picker, even before a
// credential has been saved.
const GLM_PROVIDER_ID = "glm";
const GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const kGlmProviderModels = [
  { id: "glm-5.2", name: "GLM-5.2" },
  { id: "glm-5.1", name: "GLM-5.1" },
  { id: "glm-5-turbo", name: "GLM-5-Turbo" },
  { id: "glm-5", name: "GLM-5" },
  { id: "glm-4.7", name: "GLM-4.7" },
  { id: "glm-4.7-flash", name: "GLM-4.7-Flash" },
  { id: "glm-4.7-flashx", name: "GLM-4.7-FlashX" },
  { id: "glm-4.6", name: "GLM-4.6" },
  { id: "glm-4.5-air", name: "GLM-4.5-Air" },
  { id: "glm-4.5-airx", name: "GLM-4.5-AirX" },
  { id: "glm-4.5-flash", name: "GLM-4.5-Flash" },
  { id: "glm-4-flash-250414", name: "GLM-4-Flash (250414)" },
  { id: "glm-4-flashx-250414", name: "GLM-4-FlashX (250414)" },
  { id: "glm-5v-turbo", name: "GLM-5V-Turbo", input: ["text", "image"] },
  { id: "glm-4.6v", name: "GLM-4.6V", input: ["text", "image"] },
  { id: "glm-4.6v-flash", name: "GLM-4.6V-Flash", input: ["text", "image"] },
  { id: "glm-4.6v-flashx", name: "GLM-4.6V-FlashX", input: ["text", "image"] },
  { id: "glm-4v-flash", name: "GLM-4V-Flash", input: ["text", "image"] },
  {
    id: "glm-4.1v-thinking-flashx",
    name: "GLM-4.1V-Thinking-FlashX",
    input: ["text", "image"],
  },
  {
    id: "glm-4.1v-thinking-flash",
    name: "GLM-4.1V-Thinking-Flash",
    input: ["text", "image"],
  },
  { id: "autoglm-phone", name: "AutoGLM Phone", input: ["text", "image"] },
  { id: "glm-4-voice", name: "GLM-4-Voice" },
  { id: "charglm-4", name: "CharGLM-4" },
  { id: "emohaa", name: "Emohaa" },
];

const buildGlmProviderConfig = () => ({
  baseUrl: GLM_BASE_URL,
  apiKey: "${GLM_API_KEY}",
  api: "openai-completions",
  models: kGlmProviderModels,
});

const ensureGlmProviderEntry = (cfg = {}) => {
  const before = JSON.stringify(cfg.models?.providers?.[GLM_PROVIDER_ID] || null);
  cfg.models = cfg.models || {};
  cfg.models.providers = cfg.models.providers || {};
  cfg.models.providers[GLM_PROVIDER_ID] = buildGlmProviderConfig();
  return JSON.stringify(cfg.models.providers[GLM_PROVIDER_ID]) !== before;
};

const ensureGlmProviderConfig = ({ fsModule, openclawDir }) => {
  const cfg = readOpenclawConfig({ fsModule, openclawDir, fallback: {} });
  const changed = ensureGlmProviderEntry(cfg);
  if (!changed) return false;
  writeOpenclawConfig({ fsModule, openclawDir, config: cfg, spacing: 2 });
  return true;
};

module.exports = {
  GLM_PROVIDER_ID,
  GLM_BASE_URL,
  kGlmProviderModels,
  buildGlmProviderConfig,
  ensureGlmProviderEntry,
  ensureGlmProviderConfig,
};
