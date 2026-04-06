const fs = require("fs");
const path = require("path");

const { kRootDir } = require("./constants");
const { compareVersionParts } = require("./helpers");

const getManagedAlphaclawRuntimeDir = ({ rootDir = kRootDir } = {}) =>
  path.join(rootDir, ".alphaclaw-runtime");

const getManagedAlphaclawCliPath = ({ runtimeDir } = {}) =>
  path.join(
    runtimeDir || getManagedAlphaclawRuntimeDir(),
    "node_modules",
    "@chrysb",
    "alphaclaw",
    "bin",
    "alphaclaw.js",
  );

const getManagedAlphaclawPackageJsonPath = ({ runtimeDir } = {}) =>
  path.join(
    runtimeDir || getManagedAlphaclawRuntimeDir(),
    "node_modules",
    "@chrysb",
    "alphaclaw",
    "package.json",
  );

const ensureManagedAlphaclawRuntimeProject = ({
  fsModule = fs,
  runtimeDir,
} = {}) => {
  const resolvedRuntimeDir = runtimeDir || getManagedAlphaclawRuntimeDir();
  const packageJsonPath = path.join(resolvedRuntimeDir, "package.json");
  fsModule.mkdirSync(resolvedRuntimeDir, { recursive: true });
  if (!fsModule.existsSync(packageJsonPath)) {
    fsModule.writeFileSync(
      packageJsonPath,
      JSON.stringify(
        {
          name: "alphaclaw-runtime",
          private: true,
        },
        null,
        2,
      ),
    );
  }
  return {
    runtimeDir: resolvedRuntimeDir,
    packageJsonPath,
  };
};

const readManagedAlphaclawRuntimeVersion = ({
  fsModule = fs,
  runtimeDir,
} = {}) => {
  try {
    const pkg = JSON.parse(
      fsModule.readFileSync(
        getManagedAlphaclawPackageJsonPath({ runtimeDir }),
        "utf8",
      ),
    );
    return String(pkg?.version || "").trim() || null;
  } catch {
    return null;
  }
};

const readBundledAlphaclawVersion = ({
  fsModule = fs,
  packageJsonPath = path.resolve(__dirname, "..", "..", "package.json"),
} = {}) => {
  try {
    const pkg = JSON.parse(fsModule.readFileSync(packageJsonPath, "utf8"));
    return String(pkg?.version || "").trim() || null;
  } catch {
    return null;
  }
};

const shellQuote = (value) =>
  `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;

const installManagedAlphaclawRuntime = ({
  execSyncImpl,
  fsModule = fs,
  runtimeDir,
  spec,
} = {}) => {
  const normalizedSpec =
    String(spec || "").trim() || "@chrysb/alphaclaw@latest";
  ensureManagedAlphaclawRuntimeProject({
    fsModule,
    runtimeDir,
  });
  execSyncImpl(
    `npm install ${shellQuote(normalizedSpec)} --omit=dev --no-save --save=false --package-lock=false --prefer-online`,
    {
      cwd: runtimeDir,
      stdio: "inherit",
      timeout: 180000,
    },
  );
  return {
    spec: normalizedSpec,
    version: readManagedAlphaclawRuntimeVersion({
      fsModule,
      runtimeDir,
    }),
  };
};

const syncManagedAlphaclawRuntimeWithBundled = ({
  execSyncImpl,
  fsModule = fs,
  logger = console,
  runtimeDir,
  packageJsonPath,
} = {}) => {
  const bundledVersion = readBundledAlphaclawVersion({
    fsModule,
    packageJsonPath,
  });
  if (!bundledVersion) {
    return {
      checked: false,
      synced: false,
      bundledVersion: null,
      runtimeVersion: readManagedAlphaclawRuntimeVersion({
        fsModule,
        runtimeDir,
      }),
    };
  }

  const runtimeVersion = readManagedAlphaclawRuntimeVersion({
    fsModule,
    runtimeDir,
  });
  if (runtimeVersion && compareVersionParts(runtimeVersion, bundledVersion) >= 0) {
    return {
      checked: true,
      synced: false,
      bundledVersion,
      runtimeVersion,
    };
  }

  logger.log(
    runtimeVersion
      ? `[alphaclaw] Managed AlphaClaw runtime ${runtimeVersion} is older than bundled ${bundledVersion}; syncing runtime...`
      : `[alphaclaw] Managed AlphaClaw runtime missing; seeding bundled AlphaClaw ${bundledVersion}...`,
  );
  const installResult = installManagedAlphaclawRuntime({
    execSyncImpl,
    fsModule,
    runtimeDir,
    spec: `@chrysb/alphaclaw@${bundledVersion}`,
  });
  return {
    checked: true,
    synced: true,
    bundledVersion,
    runtimeVersion: installResult.version || bundledVersion,
  };
};

module.exports = {
  ensureManagedAlphaclawRuntimeProject,
  getManagedAlphaclawCliPath,
  getManagedAlphaclawPackageJsonPath,
  getManagedAlphaclawRuntimeDir,
  installManagedAlphaclawRuntime,
  readBundledAlphaclawVersion,
  readManagedAlphaclawRuntimeVersion,
  syncManagedAlphaclawRuntimeWithBundled,
};
