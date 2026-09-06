const fs = require("fs");
const path = require("path");
const {
  readOpenclawConfig,
  resolveOpenclawConfigPath,
  writeOpenclawConfig,
} = require("./openclaw-config");
const { compareVersionParts, normalizeOpenclawVersion } = require("./helpers");

// OpenClaw 2026.8.1 moved exec approvals out of `<openclawDir>/exec-approvals.json`
// and into the shared SQLite state database
// (`<openclawDir>/state/openclaw.sqlite#exec_approvals_config`). From that release
// on, the mere existence of a non-empty legacy JSON file makes every `openclaw`
// CLI invocation fail with "Legacy exec approvals exist at ...", and
// `openclaw doctor --fix` refuses to retire it because it carries real policy
// ("retained conflicting legacy JSON"). AlphaClaw therefore must not write that
// file on 2.0+.
const kSqliteExecApprovalsMinVersion = "2026.8.1";

const kManagedExecApprovalsDefaults = Object.freeze({
  security: "full",
  ask: "off",
  askFallback: "full",
});

const kManagedOpenclawExecDefaults = Object.freeze({
  security: "full",
  strictInlineEval: false,
});

// 2.0 retired the persisted `tools.exec.security` / `tools.exec.ask` pair in
// favour of the normalized `tools.exec.mode` knob (doctor migrates the old pair).
const kManagedOpenclawExecDefaultsV2 = Object.freeze({
  mode: "full",
  strictInlineEval: false,
});

const resolveInstalledOpenclawVersion = () => {
  try {
    let dir = path.dirname(require.resolve("openclaw"));
    for (let depth = 0; depth < 6; depth += 1) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg && pkg.name === "openclaw" && pkg.version) {
          return normalizeOpenclawVersion(pkg.version);
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
};

// Returns true when the installed OpenClaw keeps exec approvals in SQLite
// (2026.8.1+). An unresolvable version falls back to the legacy path so
// behaviour on older installs is unchanged.
const usesSqliteExecApprovals = (openclawVersion) => {
  const version = normalizeOpenclawVersion(openclawVersion);
  if (!version) return false;
  return compareVersionParts(version, kSqliteExecApprovalsMinVersion) >= 0;
};

const resolveExecApprovalsConfigPath = ({ openclawDir }) =>
  path.join(openclawDir, "exec-approvals.json");

const readExecApprovalsConfig = ({
  fsModule = fs,
  openclawDir,
  fallback = { version: 1 },
} = {}) => {
  const filePath = resolveExecApprovalsConfigPath({ openclawDir });
  try {
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
};

const writeExecApprovalsConfig = ({
  fsModule = fs,
  openclawDir,
  file = {},
  spacing = 2,
} = {}) => {
  const filePath = resolveExecApprovalsConfigPath({ openclawDir });
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  fsModule.writeFileSync(filePath, JSON.stringify(file, null, spacing) + "\n", "utf8");
  return filePath;
};

// A legacy exec-approvals.json that only ever carried AlphaClaw's own managed
// defaults holds no operator state: its policy (`full` / `off` / `full`) is the
// same never-prompt baseline an unconfigured 2.0 gateway host already applies,
// and it has no allowlist or per-agent entries. Doctor still refuses to retire
// it (it is "nonempty policy", not an empty stub) and exits 1, which would block
// every other migration, so AlphaClaw archives its own file out of the way.
// Anything an operator actually edited is left alone.
const kManagedApprovalsTopLevelKeys = new Set(["version", "socket", "defaults", "agents"]);
const kManagedApprovalsDefaultKeys = new Set(["security", "ask", "askFallback"]);

const isAlphaclawManagedExecApprovalsFile = (file) => {
  if (!file || typeof file !== "object" || Array.isArray(file)) return false;
  if (Object.keys(file).some((key) => !kManagedApprovalsTopLevelKeys.has(key))) return false;
  if (file.version !== undefined && file.version !== 1) return false;
  if (file.agents !== undefined) {
    const agents = file.agents;
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) return false;
    if (Object.keys(agents).length > 0) return false;
  }
  if (file.defaults !== undefined) {
    const defaults = file.defaults;
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return false;
    if (Object.keys(defaults).some((key) => !kManagedApprovalsDefaultKeys.has(key))) return false;
    if (defaults.security !== undefined && defaults.security !== kManagedExecApprovalsDefaults.security) {
      return false;
    }
    if (defaults.ask !== undefined && defaults.ask !== kManagedExecApprovalsDefaults.ask) return false;
    if (
      defaults.askFallback !== undefined &&
      defaults.askFallback !== kManagedExecApprovalsDefaults.askFallback
    ) {
      return false;
    }
  }
  return true;
};

const retireManagedLegacyExecApprovals = ({
  fsModule = fs,
  openclawDir,
  logger = console,
  now = Date.now,
} = {}) => {
  const filePath = resolveExecApprovalsConfigPath({ openclawDir });
  if (typeof fsModule.existsSync === "function" && !fsModule.existsSync(filePath)) {
    return { retired: false, reason: "absent", path: filePath };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
  } catch (error) {
    logger?.error?.(
      `[alphaclaw] legacy exec-approvals.json is unreadable (${error.message}) - leaving it in place for \`openclaw doctor --fix\``,
    );
    return { retired: false, reason: "unreadable", path: filePath };
  }
  if (!isAlphaclawManagedExecApprovalsFile(parsed)) {
    logger?.log?.(
      `[alphaclaw] legacy exec-approvals.json carries operator policy - leaving it for \`openclaw doctor --fix\` to migrate: ${filePath}`,
    );
    return { retired: false, reason: "operator-owned", path: filePath };
  }
  const archivePath = `${filePath}.alphaclaw-retired-${now()}`;
  try {
    fsModule.renameSync(filePath, archivePath);
  } catch (error) {
    logger?.error?.(
      `[alphaclaw] failed to archive legacy exec-approvals.json (${error.message})`,
    );
    return { retired: false, reason: "rename-failed", path: filePath };
  }
  logger?.log?.(
    `[alphaclaw] archived AlphaClaw-managed legacy exec-approvals.json (blocks the OpenClaw 2.0 CLI; its policy matches the built-in gateway baseline): ${archivePath}`,
  );
  return { retired: true, reason: "archived", path: filePath, archivePath };
};

const hasOwn = (obj, key) =>
  !!obj && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

const ensureManagedExecApprovalsDefaults = (rawFile = {}) => {
  const file =
    rawFile && typeof rawFile === "object" && !Array.isArray(rawFile) ? rawFile : {};
  const before = JSON.stringify(file);
  const defaults =
    file.defaults && typeof file.defaults === "object" && !Array.isArray(file.defaults)
      ? file.defaults
      : null;
  const hasNonEmptyDefaults = !!defaults && Object.keys(defaults).length > 0;
  if (!hasNonEmptyDefaults) {
    if (!Number.isInteger(file.version)) file.version = 1;
    file.defaults = {
      security: kManagedExecApprovalsDefaults.security,
      ask: kManagedExecApprovalsDefaults.ask,
      askFallback: kManagedExecApprovalsDefaults.askFallback,
    };
    if (!file.agents || typeof file.agents !== "object" || Array.isArray(file.agents)) {
      file.agents = {};
    }
  }
  return {
    file,
    changed: JSON.stringify(file) !== before,
  };
};

const ensureManagedOpenclawExecDefaults = (rawConfig = {}, { sqliteExecApprovals = false } = {}) => {
  const config =
    rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const before = JSON.stringify(config);
  if (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)) {
    config.tools = {};
  }
  if (!hasOwn(config.tools, "exec")) {
    config.tools.exec = sqliteExecApprovals
      ? {
          mode: kManagedOpenclawExecDefaultsV2.mode,
          strictInlineEval: kManagedOpenclawExecDefaultsV2.strictInlineEval,
        }
      : {
          security: kManagedOpenclawExecDefaults.security,
          strictInlineEval: kManagedOpenclawExecDefaults.strictInlineEval,
        };
  }
  return {
    config,
    changed: JSON.stringify(config) !== before,
  };
};

const ensureManagedExecDefaults = ({
  fsModule = fs,
  openclawDir,
  openclawVersion = resolveInstalledOpenclawVersion(),
  logger = console,
} = {}) => {
  let openclawChanged = false;
  let approvalsChanged = false;
  const sqliteExecApprovals = usesSqliteExecApprovals(openclawVersion);

  const openclawConfigPath = resolveOpenclawConfigPath({ openclawDir });
  const openclawExists =
    typeof fsModule.existsSync === "function" ? fsModule.existsSync(openclawConfigPath) : null;
  if (openclawExists !== false) {
    const cfg = readOpenclawConfig({
      fsModule,
      openclawDir,
      fallback: openclawExists === true ? null : {},
    });
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
      const ensuredConfig = ensureManagedOpenclawExecDefaults(cfg, {
        sqliteExecApprovals,
      });
      if (ensuredConfig.changed) {
        writeOpenclawConfig({
          fsModule,
          openclawDir,
          config: ensuredConfig.config,
          spacing: 2,
        });
        openclawChanged = true;
      }
    }
  }

  if (sqliteExecApprovals) {
    const retired = retireManagedLegacyExecApprovals({ fsModule, openclawDir, logger });
    // 2026.8.1+ keeps exec approvals in SQLite and treats a policy-bearing
    // exec-approvals.json as a blocking legacy store. The unconfigured
    // gateway-host baseline there is already `security: full` / `ask: off`
    // (never prompt), which is exactly the managed default AlphaClaw used to
    // write, and `askFallback` is unreachable while `ask` is `off` - so there
    // is nothing left to apply. Requested policy stays aligned through
    // `tools.exec.mode` in openclaw.json above.
    logger?.log?.(
      `[alphaclaw] OpenClaw ${openclawVersion} stores exec approvals in SQLite - ` +
        `skipping legacy exec-approvals.json (managed defaults match the built-in ` +
        `gateway baseline security=full/ask=off)`,
    );
    return {
      changed: openclawChanged || retired.retired,
      openclawChanged,
      approvalsChanged: false,
      approvalsSkipped: true,
      approvalsRetired: retired.retired,
    };
  }

  const approvalsPath = resolveExecApprovalsConfigPath({ openclawDir });
  const approvalsExists =
    typeof fsModule.existsSync === "function" ? fsModule.existsSync(approvalsPath) : null;
  const approvals = readExecApprovalsConfig({
    fsModule,
    openclawDir,
    fallback: approvalsExists === true ? null : { version: 1 },
  });
  if (approvals && typeof approvals === "object" && !Array.isArray(approvals)) {
    const ensuredApprovals = ensureManagedExecApprovalsDefaults(approvals);
    if (ensuredApprovals.changed || approvalsExists === false) {
      writeExecApprovalsConfig({
        fsModule,
        openclawDir,
        file: ensuredApprovals.file,
        spacing: 2,
      });
      approvalsChanged = true;
    }
  }

  return {
    changed: openclawChanged || approvalsChanged,
    openclawChanged,
    approvalsChanged,
    approvalsSkipped: false,
    approvalsRetired: false,
  };
};

module.exports = {
  kManagedExecApprovalsDefaults,
  kManagedOpenclawExecDefaults,
  kManagedOpenclawExecDefaultsV2,
  kSqliteExecApprovalsMinVersion,
  resolveInstalledOpenclawVersion,
  usesSqliteExecApprovals,
  isAlphaclawManagedExecApprovalsFile,
  retireManagedLegacyExecApprovals,
  resolveExecApprovalsConfigPath,
  readExecApprovalsConfig,
  writeExecApprovalsConfig,
  ensureManagedExecApprovalsDefaults,
  ensureManagedOpenclawExecDefaults,
  ensureManagedExecDefaults,
};
