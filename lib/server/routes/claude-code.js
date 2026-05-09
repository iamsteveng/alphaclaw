const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const kRootDir = process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), '.alphaclaw');
const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_CODE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const CLAUDE_CODE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CODE_REDIRECT_URI = 'http://localhost:44889/callback';
const CLAUDE_CODE_AUTH_STATE_PATH = path.join(kRootDir, '.claude-auth-state.json');
const CLAUDE_CODE_CREDENTIALS_PATH = path.join(kRootDir, '.claude', '.credentials.json');
const kAuthStateMaxAgeMs = 60 * 60 * 1000;

const base64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const createPkce = () => {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
};

const readCredentials = () => {
  try {
    const raw = fs.readFileSync(CLAUDE_CODE_CREDENTIALS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ? parsed.claudeAiOauth : null;
  } catch {
    return null;
  }
};

const writeCredentials = ({ accessToken, refreshToken, expiresAt, scopes }) => {
  fs.mkdirSync(path.dirname(CLAUDE_CODE_CREDENTIALS_PATH), { recursive: true });
  const creds = {
    claudeAiOauth: {
      accessToken,
      refreshToken: refreshToken || '',
      expiresAt: expiresAt || 0,
      scopes: scopes || ['user:inference'],
    },
  };
  fs.writeFileSync(CLAUDE_CODE_CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  fs.chmodSync(CLAUDE_CODE_CREDENTIALS_PATH, 0o600);
};

const upsertEnvToken = (token, readEnvFile, writeEnvFile) => {
  const vars = readEnvFile();
  const filtered = vars.filter((v) => v.key !== 'CLAUDE_CODE_OAUTH_TOKEN');
  if (token) filtered.push({ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: token });
  writeEnvFile(filtered);
};

const registerClaudeCodeRoutes = ({ app, authProfiles, readEnvFile, writeEnvFile }) => {
  app.post('/api/claude/auth/start', (req, res) => {
    try {
      const { verifier, challenge } = createPkce();
      const state = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(
        CLAUDE_CODE_AUTH_STATE_PATH,
        JSON.stringify({ verifier, state, createdAt: Date.now() }),
        { mode: 0o600 },
      );

      const authUrl = new URL(CLAUDE_CODE_AUTHORIZE_URL);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', CLAUDE_CODE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', CLAUDE_CODE_REDIRECT_URI);
      authUrl.searchParams.set('code', 'true');
      authUrl.searchParams.set('scope', 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      res.json({ ok: true, authUrl: authUrl.toString() });
    } catch (err) {
      console.error('[claude-code] Failed to start OAuth:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/claude/auth/exchange', async (req, res) => {
    const raw = String(req.body?.code || '').trim();
    let code = raw;
    // Accept either a bare code or the full redirect URL (http://127.0.0.1:54321/?code=...&state=...)
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        code = new URL(raw).searchParams.get('code') || '';
      } catch {
        code = '';
      }
    }
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Missing authorization code' });
    }
    let stateData;
    try {
      stateData = JSON.parse(fs.readFileSync(CLAUDE_CODE_AUTH_STATE_PATH, 'utf8'));
    } catch {
      return res.status(409).json({ ok: false, error: 'Auth session expired. Start OAuth again.' });
    }
    if (!stateData?.verifier || Date.now() - stateData.createdAt > kAuthStateMaxAgeMs) {
      fs.rmSync(CLAUDE_CODE_AUTH_STATE_PATH, { force: true });
      return res.status(409).json({ ok: false, error: 'Auth session expired. Start OAuth again.' });
    }
    fs.rmSync(CLAUDE_CODE_AUTH_STATE_PATH, { force: true });

    try {
      const tokenRes = await fetch(CLAUDE_CODE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLAUDE_CODE_CLIENT_ID,
          code,
          code_verifier: stateData.verifier,
          redirect_uri: CLAUDE_CODE_REDIRECT_URI,
        }),
      });
      const json = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !json.access_token) {
        throw new Error(`Token exchange failed (${tokenRes.status}): ${json.error_description || json.error || ''}`);
      }

      const accessToken = String(json.access_token);
      const refreshToken = String(json.refresh_token || '');
      const expiresAt = json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : 0;
      const scopes = ['user:inference'];

      writeCredentials({ accessToken, refreshToken, expiresAt, scopes });
      upsertEnvToken(accessToken, readEnvFile, writeEnvFile);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;

      if (authProfiles?.upsertClaudeCodeProfile) {
        authProfiles.upsertClaudeCodeProfile({ accessToken, refreshToken, expiresAt, scopes });
      }

      console.log('[claude-code] OAuth exchange successful');
      return res.json({ ok: true });
    } catch (err) {
      console.error('[claude-code] Token exchange error:', err.message);
      return res.status(500).json({ ok: false, error: err.message || 'Token exchange failed' });
    }
  });

  app.get('/api/claude/auth/status', (req, res) => {
    const creds = readCredentials();
    if (creds?.accessToken) {
      return res.json({
        configured: true,
        method: 'oauth',
        expiresAt: creds.expiresAt || null,
        tokenPreview: creds.accessToken.slice(0, 20) + '...',
        fullToken: creds.accessToken,
      });
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return res.json({ configured: true, method: 'api-key', expiresAt: null, tokenPreview: null, fullToken: null });
    }
    return res.json({ configured: false, method: 'unconfigured', expiresAt: null, tokenPreview: null, fullToken: null });
  });

  app.post('/api/claude/auth/disconnect', (req, res) => {
    try {
      fs.rmSync(CLAUDE_CODE_CREDENTIALS_PATH, { force: true });
    } catch {}
    upsertEnvToken('', readEnvFile, writeEnvFile);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (authProfiles?.removeClaudeCodeProfiles) authProfiles.removeClaudeCodeProfiles();
    console.log('[claude-code] Disconnected');
    res.json({ ok: true });
  });
};

module.exports = { registerClaudeCodeRoutes };
