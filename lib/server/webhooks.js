const path = require("path");

const kNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const getConfigPath = ({ OPENCLAW_DIR }) => path.join(OPENCLAW_DIR, "openclaw.json");

const readConfig = ({ fs, constants }) => {
  const configPath = getConfigPath(constants);
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return { cfg, configPath };
};

const writeConfig = ({ fs, configPath, cfg }) => {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
};

const getTransformRelativePath = (name) => `hooks/transforms/${name}/${name}-transform.mjs`;
const getTransformModulePath = (name) => `${name}/${name}-transform.mjs`;
const getTransformAbsolutePath = ({ OPENCLAW_DIR }, name) =>
  path.join(OPENCLAW_DIR, getTransformRelativePath(name));

const ensureHooksRoot = (cfg) => {
  if (!cfg.hooks) cfg.hooks = {};
  if (!Array.isArray(cfg.hooks.mappings)) {
    cfg.hooks.mappings = [];
  }
  if (typeof cfg.hooks.enabled !== "boolean") cfg.hooks.enabled = true;
  if (typeof cfg.hooks.path !== "string" || !cfg.hooks.path.trim()) cfg.hooks.path = "/hooks";
  if (typeof cfg.hooks.token !== "string" || !cfg.hooks.token.trim()) {
    cfg.hooks.token = "${WEBHOOK_TOKEN}";
  }
  return cfg.hooks.mappings;
};

const getMappingHookName = (mapping) => String(mapping?.match?.path || "").trim();
const isWebhookMapping = (mapping) => !!getMappingHookName(mapping);
const findMappingIndexByName = (mappings, name) =>
  mappings.findIndex((mapping) => getMappingHookName(mapping) === name);

const validateWebhookName = (name) => {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) throw new Error("Webhook name is required");
  if (!kNamePattern.test(normalized)) {
    throw new Error("Webhook name must be lowercase letters, numbers, and hyphens");
  }
  return normalized;
};

const migrateLegacyWebhookConfig = (cfg) => {
  const legacyEntries = cfg?.hooks?.webhook?.entries;
  if (!legacyEntries || typeof legacyEntries !== "object") return false;
  const mappings = ensureHooksRoot(cfg);
  for (const [rawName, rawEntry] of Object.entries(legacyEntries)) {
    const name = validateWebhookName(rawName);
    if (findMappingIndexByName(mappings, name) !== -1) continue;
    const transformPath = String(rawEntry?.transform || getTransformRelativePath(name));
    const transformModule = transformPath
      .replace(/^hooks\/transforms\//, "")
      .replace(/^\/+/, "");
    mappings.push({
      match: { path: name },
      action: "agent",
      name,
      wakeMode: "now",
      transform: { module: transformModule || getTransformModulePath(name) },
    });
  }
  delete cfg.hooks.webhook;
  return true;
};

const resolveTransformPathFromMapping = (name, mapping) => {
  const modulePath = String(mapping?.transform?.module || "").trim();
  if (!modulePath) return getTransformRelativePath(name);
  return `hooks/transforms/${modulePath.replace(/^\/+/, "")}`;
};

const listWebhooks = ({ fs, constants }) => {
  const { cfg, configPath } = readConfig({ fs, constants });
  const migrated = migrateLegacyWebhookConfig(cfg);
  const mappings = ensureHooksRoot(cfg);
  if (migrated) writeConfig({ fs, configPath, cfg });
  return mappings
    .filter(isWebhookMapping)
    .map((mapping) => {
      const name = getMappingHookName(mapping);
      const transformPath = resolveTransformPathFromMapping(name, mapping);
      const transformAbsolutePath = path.join(constants.OPENCLAW_DIR, transformPath);
      let createdAt = null;
      try {
        const stat = fs.statSync(transformAbsolutePath);
        createdAt = stat.birthtime?.toISOString?.() || stat.ctime?.toISOString?.() || null;
      } catch {}
      return {
        name,
        enabled: true,
        createdAt,
        path: `/hooks/${name}`,
        transformPath,
        transformExists: fs.existsSync(transformAbsolutePath),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

const getWebhookDetail = ({ fs, constants, name }) => {
  const webhookName = validateWebhookName(name);
  const hooks = listWebhooks({ fs, constants });
  const detail = hooks.find((item) => item.name === webhookName);
  if (!detail) return null;
  const transformAbsolutePath = path.join(constants.OPENCLAW_DIR, detail.transformPath);
  return {
    ...detail,
    transformExists: fs.existsSync(transformAbsolutePath),
  };
};

const ensureStarterTransform = ({ fs, constants, name }) => {
  const transformAbsolutePath = getTransformAbsolutePath(constants, name);
  fs.mkdirSync(path.dirname(transformAbsolutePath), { recursive: true });
  if (fs.existsSync(transformAbsolutePath)) return transformAbsolutePath;
  fs.writeFileSync(
    transformAbsolutePath,
    [
      "export default async function transform(payload, context) {",
      "  return payload;",
      "}",
      "",
    ].join("\n"),
  );
  return transformAbsolutePath;
};

const createWebhook = ({ fs, constants, name }) => {
  const webhookName = validateWebhookName(name);
  const { cfg, configPath } = readConfig({ fs, constants });
  migrateLegacyWebhookConfig(cfg);
  const mappings = ensureHooksRoot(cfg);
  if (findMappingIndexByName(mappings, webhookName) !== -1) {
    throw new Error(`Webhook "${webhookName}" already exists`);
  }
  mappings.push({
    match: { path: webhookName },
    action: "agent",
    name: webhookName,
    wakeMode: "now",
    transform: { module: getTransformModulePath(webhookName) },
  });

  writeConfig({ fs, configPath, cfg });
  ensureStarterTransform({ fs, constants, name: webhookName });
  return getWebhookDetail({ fs, constants, name: webhookName });
};

const deleteWebhook = ({ fs, constants, name }) => {
  const webhookName = validateWebhookName(name);
  const { cfg, configPath } = readConfig({ fs, constants });
  migrateLegacyWebhookConfig(cfg);
  const mappings = ensureHooksRoot(cfg);
  const index = findMappingIndexByName(mappings, webhookName);
  if (index === -1) return false;
  mappings.splice(index, 1);
  writeConfig({ fs, configPath, cfg });
  return true;
};

module.exports = {
  listWebhooks,
  getWebhookDetail,
  createWebhook,
  deleteWebhook,
  validateWebhookName,
  getTransformRelativePath,
};
