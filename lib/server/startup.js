const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { kRootDir, ALPHACLAW_DIR, WORKSPACE_DIR, OPENCLAW_DIR, kBootstrapModelCatalog } = require('./constants');
const { installHourlyGitSyncCron } = require('./onboarding/cron');
const { ensureClaudeCodeAuth } = require('./claude-code-auth');
const { ensureXTwitterAuth } = require('./x-twitter-auth');
const { validateCatalogProviderRegistry } = require('./model-catalog-validation');
const { resolveInstalledOpenclawVersion } = require('./exec-defaults-config');

const kGbrainRecoveryDelayMs = 30 * 1000;

// One-time per-OpenClaw-version state migration. `openclaw doctor --fix` owns
// every persistent file-to-SQLite migration (auth profiles, exec approvals,
// session stores). It must run with the gateway stopped — it takes the same
// state-ownership lock the gateway holds — so it runs once here, right before
// the first gateway spawn of the boot.
const kOpenclawDoctorMarkerPath = path.join(ALPHACLAW_DIR, 'openclaw-doctor-version');
// Doctor blocks the boot (and the event loop) until it finishes — it must not
// still be running when Railway's healthcheck window (`healthcheckTimeout = 300`
// in railway.toml) expires, or the platform restarts the container mid-migration.
// The migration itself took ~85s on the 2026.5.6 → 2026.9.1 upgrade rehearsal.
const kOpenclawDoctorTimeoutMs = 4 * 60 * 1000;
const kOpenclawDoctorMaxBuffer = 8 * 1024 * 1024;
const kOpenclawDoctorLogLines = 12;

const lastLines = (output, count = kOpenclawDoctorLogLines) =>
  String(output || '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join('\n');

const runOpenclawUpgradeDoctor = ({
  fsModule = fs,
  execSyncImpl = execSync,
  markerPath = kOpenclawDoctorMarkerPath,
  openclawVersion = resolveInstalledOpenclawVersion(),
  env = null,
  timeoutMs = kOpenclawDoctorTimeoutMs,
  logger = console,
} = {}) => {
  try {
    if (!openclawVersion) {
      logger.log('[alphaclaw] openclaw doctor migration skipped: installed OpenClaw version is unknown');
      return { ran: false, ok: false, reason: 'unknown-version', version: null };
    }

    let marker = null;
    try {
      marker = String(fsModule.readFileSync(markerPath, 'utf8')).trim();
    } catch {
      marker = null;
    }
    if (marker === openclawVersion) {
      return { ran: false, ok: true, reason: 'up-to-date', version: openclawVersion };
    }

    const doctorEnv = env || require('./gateway').gatewayEnv();
    logger.log(
      `[alphaclaw] openclaw doctor migration: ${marker || '(none)'} → ${openclawVersion} — running \`openclaw doctor --fix --non-interactive\` before gateway start`,
    );

    let code = 0;
    let output = '';
    try {
      output = execSyncImpl('openclaw doctor --fix --non-interactive', {
        env: doctorEnv,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: kOpenclawDoctorMaxBuffer,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      code = Number.isInteger(error?.status) ? error.status : 1;
      output = `${error?.stdout || ''}${error?.stderr || ''}` || error?.message || '';
    }

    const tail = lastLines(output);
    logger.log(`[alphaclaw] openclaw doctor --fix exited ${code}${tail ? `:\n${tail}` : ''}`);

    if (code === 0) {
      fsModule.mkdirSync(path.dirname(markerPath), { recursive: true });
      fsModule.writeFileSync(markerPath, `${openclawVersion}\n`, 'utf8');
      logger.log(`[alphaclaw] openclaw doctor migration complete — marker written: ${markerPath}`);
      return { ran: true, ok: true, reason: 'repaired', version: openclawVersion, code };
    }

    logger.error(
      `[alphaclaw] openclaw doctor --fix failed (exit ${code}) — continuing boot; marker not written`,
    );
    return { ran: true, ok: false, reason: 'failed', version: openclawVersion, code };
  } catch (error) {
    // Never block boot on the migration step.
    logger.error(`[alphaclaw] openclaw doctor migration error (non-fatal): ${error.message}`);
    return { ran: false, ok: false, reason: 'error', version: openclawVersion || null };
  }
};

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

const kOllamaEmbeddingModel = 'ollama:nomic-embed-text';
const kOllamaEmbeddingDimensions = 768;

// Ollama/llama-server are local-only providers with no API key — gbrain's
// own env-detection (groupReadyByProvider) deliberately excludes providers
// with no required auth_env from auto-pick, so OLLAMA_BASE_URL/
// LLAMA_SERVER_BASE_URL are never picked up on their own. This mirrors
// ensureGbrainDatabaseConfig()'s detect-and-wire-up pattern for DATABASE_URL
// to close that gap explicitly.
const ensureGbrainEmbeddingConfig = () => {
  const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL;
  const LLAMA_SERVER_BASE_URL = process.env.LLAMA_SERVER_BASE_URL;

  if (!OLLAMA_BASE_URL && !LLAMA_SERVER_BASE_URL) return;

  if (!OLLAMA_BASE_URL && LLAMA_SERVER_BASE_URL) {
    // llama-server has no canonical default embedding model (gbrain flags it
    // user_provided_models and refuses to auto-pick) — nothing safe to wire
    // in automatically; point at the manual path instead.
    console.log(
      '[alphaclaw] gbrain: LLAMA_SERVER_BASE_URL detected, but llama-server has no default ' +
        'embedding model — run `gbrain init --embedding-model llama-server:<model> ' +
        '--embedding-dimensions <N>` manually to wire it up.',
    );
    return;
  }

  const configPath = path.join(kRootDir, '.gbrain', 'config.json');

  try {
    let config = null;
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        // Corrupt config — fall through and let `gbrain init` rewrite it.
      }
    }

    if (config?.embedding_model === kOllamaEmbeddingModel) {
      console.log('[alphaclaw] gbrain: embedding config is current');
      return;
    }

    const engine = config?.engine ?? (process.env.DATABASE_URL ? 'postgres' : 'pglite');
    const engineFlag = engine === 'pglite' ? '--pglite' : '--supabase';

    console.log(
      `[alphaclaw] gbrain: OLLAMA_BASE_URL detected — wiring embedding provider ` +
        `(${kOllamaEmbeddingModel}, ${kOllamaEmbeddingDimensions}d) into ${engine} config...`,
    );
    try {
      execSync(
        `gbrain init ${engineFlag} --non-interactive --embedding-model ${kOllamaEmbeddingModel} ` +
          `--embedding-dimensions ${kOllamaEmbeddingDimensions}`,
        {
          timeout: 120000,
          shell: true,
          stdio: 'inherit',
          env: { ...process.env, HOME: kRootDir },
        },
      );
      console.log('[alphaclaw] gbrain: embedding provider wired up');
    } catch (err) {
      console.error('[alphaclaw] gbrain: embedding provider wire-up failed (non-fatal):', err.message);
    }
  } catch (err) {
    console.error('[alphaclaw] gbrain embedding config failed (non-fatal):', err.message);
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
  // Injectable so tests can stub the one-time doctor migration; production
  // callers (lib/server.js → init/server-lifecycle.js) take the default.
  runOpenclawDoctorMigration = runOpenclawUpgradeDoctor,
  ensureManagedExecDefaults,
  ensureUsageTrackerPluginConfig,
  ensureAcpAgentConfig,
  ensureGatewayProviderConfig,
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
  try {
    ensureUsageTrackerPluginConfig({ fsModule: fs, openclawDir: OPENCLAW_DIR });
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure usage-tracker plugin config on boot: ${error.message}`,
    );
  }
  try {
    ensureAcpAgentConfig({ fsModule: fs, openclawDir: OPENCLAW_DIR });
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure ACP agent config on boot: ${error.message}`,
    );
  }
  try {
    ensureGatewayProviderConfig({ fsModule: fs, openclawDir: OPENCLAW_DIR });
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to ensure gateway provider config on boot: ${error.message}`,
    );
  }
  try {
    // Non-fatal catalog↔registry consistency check: warns (never crashes) when
    // the model catalog references a provider id with no Provider Registry entry.
    validateCatalogProviderRegistry({ catalog: kBootstrapModelCatalog });
  } catch (error) {
    console.error(
      `[alphaclaw] Failed to validate catalog provider registry on boot: ${error.message}`,
    );
  }
  doSyncPromptFiles();
  reloadEnv();
  syncChannelConfig(readEnvFile());
  ensureGatewayProxyConfig(resolveSetupUrl());
  ensureGbrainDatabaseConfig();
  ensureGbrainEmbeddingConfig();
  installHourlyGitSyncCron({ fs, openclawDir: OPENCLAW_DIR }).catch((err) =>
    console.error('[alphaclaw] System cron re-install failed (non-fatal):', err.message),
  );
  runOpenclawDoctorMigration();
  startGateway();
  watchdog.start();
  gmailWatchService.start();
  setTimeout(runGbrainRecoveryCheck, kGbrainRecoveryDelayMs);
};

module.exports = {
  runOnboardedBootSequence,
  runOpenclawUpgradeDoctor,
  kOpenclawDoctorMarkerPath,
  ensureGbrainPersistentDbPath,
  ensureGbrainDatabaseConfig,
  ensureGbrainEmbeddingConfig,
};
