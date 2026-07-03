const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildOnboardArgs,
  writeManagedImportOpenclawConfig,
  writeSanitizedOpenclawConfig,
} = require("../../lib/server/onboarding/openclaw");
const {
  ensureImportedSystemVarSecrets,
} = require("../../lib/server/onboarding/index");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-onboarding-openclaw-test-"));

describe("server/onboarding/openclaw", () => {
  it("builds onboarding args from submitted vars instead of stale process env auth", () => {
    process.env.ANTHROPIC_TOKEN = "sk-ant-oat01-stale-token";

    const args = buildOnboardArgs({
      varMap: {
        ANTHROPIC_API_KEY: "sk-ant-api-fresh-key",
        OPENCLAW_GATEWAY_TOKEN: "gw-token",
      },
      selectedProvider: "anthropic",
      hasCodexOauth: false,
      workspaceDir: "/tmp/workspace",
    });

    expect(args).toContain("--anthropic-api-key");
    expect(args).toContain("sk-ant-api-fresh-key");
    expect(args).not.toContain("--token");
    expect(args).not.toContain("sk-ant-oat01-stale-token");

    delete process.env.ANTHROPIC_TOKEN;
  });

  it("only scrubs exact secret string values in JSON", () => {
    const { kUsageTrackerPluginPath } = require("../../lib/server/usage-tracker-config");
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    // Start with the legacy npm path — writeSanitizedOpenclawConfig should migrate it to the
    // current app path and NOT substitute secret placeholder values into path strings.
    const stalePluginPath = "/app/node_modules/@chrysb/alphaclaw/lib/plugin/usage-tracker";
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: {
            allow: ["memory-core"],
            load: { paths: [stalePluginPath] },
            entries: {},
          },
          channels: {},
          notes: "alphaclaw",
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: { GOG_KEYRING_PASSWORD: "alphaclaw" },
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.notes).toBe("${GOG_KEYRING_PASSWORD}");
    expect(next.plugins.allow).toEqual(["memory-core", "usage-tracker"]);
    // Stale npm path replaced by current app path
    expect(next.plugins.load.paths).toContain(kUsageTrackerPluginPath);
    expect(next.plugins.load.paths).not.toContain(stalePluginPath);
    // Secret placeholder must not bleed into path strings
    expect(next.plugins.load.paths).not.toContain(
      "/app/node_modules/@chrysb/${GOG_KEYRING_PASSWORD}/lib/plugin/usage-tracker",
    );
  });

  it("creates plugins.allow when missing before adding usage-tracker", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { load: { paths: [] }, entries: {} },
          channels: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    writeSanitizedOpenclawConfig({
      fs,
      openclawDir,
      varMap: {},
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.plugins.allow).toEqual(["usage-tracker"]);
    // Custom plugins must not appear in plugins.entries — openclaw rejects them
    expect(next.plugins.entries["usage-tracker"]).toBeUndefined();
  });

  it("resets imported allowlist dmPolicy to pairing when re-enabling discord", () => {
    const openclawDir = createTempOpenclawDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: { allow: [], load: { paths: [] }, entries: {} },
          channels: {
            discord: {
              enabled: false,
              dmPolicy: "allowlist",
              allowFrom: [],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    writeManagedImportOpenclawConfig({
      fs,
      openclawDir,
      varMap: { DISCORD_BOT_TOKEN: "discord-live-secret" },
    });

    const next = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(next.channels.discord.enabled).toBe(true);
    expect(next.channels.discord.dmPolicy).toBe("pairing");
    expect(next.channels.discord.token).toBe("${DISCORD_BOT_TOKEN}");
  });
});

describe("server/onboarding/index ensureImportedSystemVarSecrets", () => {
  const systemVars = new Set(["OPENCLAW_GATEWAY_TOKEN", "WEBHOOK_TOKEN"]);

  it("generates a fresh secret for a system var referenced by an imported config with no existing value", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({
        gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
        hooks: { token: "${WEBHOOK_TOKEN}" },
      }),
      "utf8",
    );

    const varsToSave = [];
    ensureImportedSystemVarSecrets({
      fs,
      openclawDir,
      varsToSave,
      systemVars,
    });

    const gatewayToken = varsToSave.find((v) => v.key === "OPENCLAW_GATEWAY_TOKEN");
    const webhookToken = varsToSave.find((v) => v.key === "WEBHOOK_TOKEN");
    expect(gatewayToken?.value).toBeTruthy();
    expect(webhookToken?.value).toBeTruthy();
    expect(gatewayToken.value).not.toBe(webhookToken.value);
  });

  it("does not overwrite a system var that already has a value", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } } }),
      "utf8",
    );

    const varsToSave = [{ key: "OPENCLAW_GATEWAY_TOKEN", value: "existing-token" }];
    ensureImportedSystemVarSecrets({
      fs,
      openclawDir,
      varsToSave,
      systemVars,
    });

    expect(varsToSave.find((v) => v.key === "OPENCLAW_GATEWAY_TOKEN")?.value).toBe(
      "existing-token",
    );
  });

  it("does not add a system var that the imported config never references", () => {
    const openclawDir = createTempOpenclawDir();
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } } }),
      "utf8",
    );

    const varsToSave = [];
    ensureImportedSystemVarSecrets({
      fs,
      openclawDir,
      varsToSave,
      systemVars,
    });

    expect(varsToSave.find((v) => v.key === "WEBHOOK_TOKEN")).toBeUndefined();
  });
});
