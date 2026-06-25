const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { kRootDir, WORKSPACE_DIR, OPENCLAW_DIR } = require('./constants');
const { installHourlyGitSyncCron } = require('./onboarding/cron');
const { ensureClaudeCodeAuth } = require('./claude-code-auth');
const { ensureXTwitterAuth } = require('./x-twitter-auth');

const kGbrainRecoveryDelayMs = 30 * 1000;

const ensureGbrainPersistentDbPath = () => {
  const configPath = path.join(kRootDir, '.gbrain', 'config.json');
  const targetPath = path.join(kRootDir, '.gbrain', 'brain.pglite');

  try {
    if (!fs.existsSync(configPath)) return;

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const currentPath = config.database_path;

    // No-op: already inside the persistent volume (boundary-safe — startsWith alone
    // would match sibling paths like /data-old/ which are not inside /data/).
    if (currentPath) {
      const rel = path.relative(kRootDir, currentPath);
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return;
    }

    if (fs.existsSync(targetPath)) {
      config.database_path = targetPath;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`[alphaclaw] gbrain database_path updated (destination already exists, skipped copy): ${currentPath} → ${targetPath}`);
      return;
    }

    let copied = false;
    if (currentPath && fs.existsSync(currentPath)) {
      // Atomic copy via tmp dir + rename so an interrupted deploy can't leave a
      // half-written pglite that blocks recovery on the next boot.
      const tmpPath = targetPath + '.tmp';
      if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { recursive: true, force: true });
      }
      fs.cpSync(currentPath, tmpPath, { recursive: true });
      fs.renameSync(tmpPath, targetPath);
      copied = true;
    }

    config.database_path = targetPath;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    if (copied) {
      console.log(`[alphaclaw] gbrain database_path migrated: ${currentPath} → ${targetPath}`);
    } else {
      console.log(`[alphaclaw] gbrain database_path updated (source absent, no copy): ${currentPath} → ${targetPath}`);
    }
  } catch (err) {
    console.error('[alphaclaw] gbrain persistent db path migration failed (non-fatal):', err.message);
  }
};

const ensureGbrainDatabaseConfig = () => {
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!DATABASE_URL) {
    ensureGbrainPersistentDbPath();
    return;
  }

  const configPath = path.join(kRootDir, '.gbrain', 'config.json');

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    let config = null;
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        // Corrupt config — treat as fresh install
      }
    }

    const currentEngine = config?.engine ?? null;

    if (!currentEngine) {
      const freshConfig = { engine: 'postgres', database_url: DATABASE_URL };
      fs.writeFileSync(configPath, JSON.stringify(freshConfig, null, 2));
      console.log('[alphaclaw] gbrain: fresh postgres config written');
      try {
        execSync('gbrain apply-migrations --yes', {
          timeout: 120000,
          shell: true,
          stdio: 'inherit',
          env: { ...process.env, HOME: kRootDir },
        });
        console.log('[alphaclaw] gbrain: postgres schema initialised');
      } catch (err) {
        console.error('[alphaclaw] gbrain: postgres schema init failed (non-fatal):', err.message);
      }
    } else if (currentEngine === 'pglite') {
      ensureGbrainPersistentDbPath();
      console.log('[alphaclaw] gbrain: DATABASE_URL detected — pglite→postgres migration scheduled');
    } else if (currentEngine === 'postgres') {
      if (config.database_url !== DATABASE_URL) {
        config.database_url = DATABASE_URL;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('[alphaclaw] gbrain: DATABASE_URL updated in postgres config');
      } else {
        console.log('[alphaclaw] gbrain: postgres config is current');
      }
    }
  } catch (err) {
    console.error('[alphaclaw] gbrain database config failed (non-fatal):', err.message);
  }
};

const runGbrainRecoveryCheck = () => {
  const DATABASE_URL = process.env.DATABASE_URL;
  const configPath = path.join(kRootDir, '.gbrain', 'config.json');
  const brainDir = path.join(WORKSPACE_DIR, 'brain');

  try {
    let currentEngine = 'pglite';
    try {
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        currentEngine = cfg.engine || 'pglite';
      }
    } catch { /* default to pglite */ }

    const gbrainEnv = { ...process.env, HOME: kRootDir };

    if (DATABASE_URL && currentEngine === 'pglite') {
      // DATABASE_URL must NOT appear in the child env: gbrain's loadConfig()
      // overrides the engine to 'postgres' whenever that env var is present,
      // so `gbrain migrate --to supabase` would see "already on postgres" and
      // exit 1 before copying any rows.
      console.log('[alphaclaw] gbrain: migrating pglite → postgres...');
      const migrateEnv = { ...gbrainEnv };
      delete migrateEnv.DATABASE_URL;
      delete migrateEnv.GBRAIN_DATABASE_URL;
      try {
        execSync(
          `gbrain migrate --to supabase --url ${JSON.stringify(DATABASE_URL)}`,
          { timeout: 300000, shell: true, stdio: 'inherit', env: migrateEnv },
        );
        console.log('[alphaclaw] gbrain migration to postgres complete');
      } catch (err) {
        console.error('[alphaclaw] gbrain migration to postgres failed (non-fatal):', err.message);
      }
      return;
    }

    if (DATABASE_URL && currentEngine === 'postgres') {
      console.log('[alphaclaw] gbrain: applying schema migrations...');
      try {
        execSync('gbrain apply-migrations --yes', {
          timeout: 120000,
          shell: true,
          stdio: 'inherit',
          env: gbrainEnv,
        });
        console.log('[alphaclaw] gbrain: schema migrations applied');
      } catch (err) {
        console.error('[alphaclaw] gbrain: apply-migrations failed (non-fatal):', err.message);
      }
      return;
    }

    // Pglite health check and flat-file recovery (DATABASE_URL not set)
    let pageCount = 0;
    try {
      const out = execSync(
        `timeout 10 env HOME=${kRootDir} gbrain list 2>/dev/null`,
        { encoding: 'utf8', shell: true },
      ).trim();
      // gbrain prints "No pages found." (one line) on empty brain — not a page entry
      if (out && !/No pages found/i.test(out)) {
        pageCount = out.split('\n').filter(Boolean).length;
      }
    } catch {
      pageCount = 0;
    }

    console.log(`[alphaclaw] gbrain health check: ${pageCount} pages`);

    if (pageCount === 0) {
      let flatFileCount = 0;
      try {
        const out = execSync(
          `find ${brainDir} -name "*.md" 2>/dev/null | wc -l`,
          { encoding: 'utf8', shell: true },
        ).trim();
        flatFileCount = parseInt(out, 10) || 0;
      } catch { /* brain dir may not exist yet */ }

      if (flatFileCount > 0) {
        console.log(
          `[alphaclaw] gbrain empty but ${flatFileCount} flat files found — running auto-recovery import`,
        );
        try {
          execSync(
            `env HOME=${kRootDir} gbrain import ${brainDir} --no-embed`,
            { timeout: 120000, shell: true, stdio: 'inherit' },
          );
          console.log('[alphaclaw] gbrain auto-recovery import complete');
        } catch (importErr) {
          console.error('[alphaclaw] gbrain auto-recovery import failed:', importErr.message);
        }
      } else {
        console.log('[alphaclaw] gbrain health check: no pages and no flat files — skipping recovery');
      }
    }
  } catch (err) {
    console.error('[alphaclaw] gbrain health check error:', err.message);
  }
};

const runOnboardedBootSequence = ({
  ensureManagedExecDefaults,
  ensureUsageTrackerPluginConfig,
  doSyncPromptFiles,
  reloadEnv,
  syncChannelConfig,
  readEnvFile,
  ensureGatewayProxyConfig,
  resolveSetupUrl,
  startGateway,
  watchdog,
  gmailWatchService,
}) => {
  ensureClaudeCodeAuth().catch((err) =>
    console.error('[alphaclaw] Claude Code auth init failed:', err.message),
  );
  try { ensureXTwitterAuth(); } catch (err) {
    console.error('[alphaclaw] X Twitter auth init failed:', err.message);
  }
  try {
    ensureManagedExecDefaults();
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure managed exec defaults on boot: ${error.message}`,
    );
  }
  const _readPluginPaths = () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, 'openclaw.json'), 'utf8'));
      return (cfg?.plugins?.load?.paths || []).join(', ') || '(empty)';
    } catch (e) { return `(read error: ${e.message})`; }
  };
  console.log(`[alphaclaw] plugin paths before fix: ${_readPluginPaths()}`);
  try {
    ensureUsageTrackerPluginConfig({ fsModule: fs, openclawDir: OPENCLAW_DIR });
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure usage-tracker plugin config on boot: ${error.message}`,
    );
  }
  console.log(`[alphaclaw] plugin paths after fix: ${_readPluginPaths()}`);
  doSyncPromptFiles();
  reloadEnv();
  syncChannelConfig(readEnvFile());
  console.log(`[alphaclaw] plugin paths after syncChannelConfig: ${_readPluginPaths()}`);
  ensureGatewayProxyConfig(resolveSetupUrl());
  ensureGbrainDatabaseConfig();
  installHourlyGitSyncCron({ fs, openclawDir: OPENCLAW_DIR }).catch((err) =>
    console.error('[alphaclaw] System cron re-install failed (non-fatal):', err.message),
  );
  console.log(`[alphaclaw] plugin paths before startGateway: ${_readPluginPaths()}`);
  startGateway();
  watchdog.start();
  gmailWatchService.start();
  setTimeout(runGbrainRecoveryCheck, kGbrainRecoveryDelayMs);
};

module.exports = {
  runOnboardedBootSequence,
  ensureGbrainPersistentDbPath,
  ensureGbrainDatabaseConfig,
};
