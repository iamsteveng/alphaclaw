const fs = require('fs');
const path = require('path');
const os = require('os');

const kRootDir = process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), '.alphaclaw');
const CREDENTIALS_PATH = path.join(kRootDir, '.claude', '.credentials.json');
const AUTH_STATE_PATH = path.join(kRootDir, '.claude-auth-state.json');
const kAuthStateMaxAgeMs = 60 * 60 * 1000;

const readCredentials = () => {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ? parsed.claudeAiOauth : null;
  } catch {
    return null;
  }
};

const ensureClaudeCodeAuth = async () => {
  // Step 2.0: idempotent directory creation (must run BEFORE anything else)
  try {
    fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(CREDENTIALS_PATH), 0o700);
  } catch {}

  // Cleanup stale auth state files
  try {
    const stat = fs.statSync(AUTH_STATE_PATH);
    if (Date.now() - stat.mtimeMs > kAuthStateMaxAgeMs) {
      fs.rmSync(AUTH_STATE_PATH, { force: true });
    }
  } catch {}

  // Step 2.1: Volume credentials file takes precedence
  const existing = readCredentials();
  if (existing?.accessToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = existing.accessToken;
    console.log('[alphaclaw] Claude Code: OAuth credentials loaded from volume');
    return;
  }

  // Step 2.2: Env var token -> write credentials file
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken) {
    try {
      const creds = {
        claudeAiOauth: {
          accessToken: oauthToken,
          refreshToken: '',
          expiresAt: 0,
          scopes: ['user:inference'],
        },
      };
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
      fs.chmodSync(CREDENTIALS_PATH, 0o600);
      console.log('[alphaclaw] Claude Code: OAuth token auth active (from env)');
    } catch (err) {
      console.error('[alphaclaw] Claude Code: Failed to write credentials file:', err.message);
    }
    return;
  }

  // Step 2.3: API key fallback
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('[alphaclaw] Claude Code: API key auth active');
    return;
  }

  // Step 2.4: Unconfigured
  console.warn('[alphaclaw] claude_code_auth: unconfigured (set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)');
};

const getClaudeCodeAuthStatus = () => {
  const creds = readCredentials();
  if (creds?.accessToken) return { method: 'oauth', configured: true };
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { method: 'oauth', configured: true };
  if (process.env.ANTHROPIC_API_KEY) return { method: 'api-key', configured: true };
  return { method: 'unconfigured', configured: false };
};

module.exports = { ensureClaudeCodeAuth, getClaudeCodeAuthStatus };
