const { execSync, spawn } = require('child_process');

const GH_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
// Default: gh CLI's own public OAuth app client ID (same one `gh auth login` uses)
// Override with GH_OAUTH_CLIENT_ID env var to use your own GitHub OAuth App
const GH_CLIENT_ID = process.env.GH_OAUTH_CLIENT_ID || '178c6fc778ccc68e1d6a';
const GH_SCOPE = 'repo,read:org,gist';

const storeGhToken = (token) =>
  new Promise((resolve, reject) => {
    const proc = spawn('gh', ['auth', 'login', '--with-token'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.write(token);
    proc.stdin.end();
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh auth login failed (${code}): ${stderr.trim()}`));
    });
    proc.on('error', reject);
  });

const getGhUser = () => {
  try {
    return execSync('gh api user --jq .login', { encoding: 'utf8', stdio: 'pipe' }).trim() || null;
  } catch {
    return null;
  }
};

const registerGhAuthRoutes = ({ app }) => {
  app.post('/api/gh/auth/device/start', async (req, res) => {
    try {
      const response = await fetch(GH_DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ client_id: GH_CLIENT_ID, scope: GH_SCOPE }),
      });
      const data = await response.json();
      if (!data.device_code) {
        throw new Error(data.error_description || data.error || 'Device code request failed');
      }
      res.json({
        ok: true,
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
        interval: data.interval || 5,
      });
    } catch (err) {
      console.error('[gh-auth] device/start error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/gh/auth/device/poll', async (req, res) => {
    const device_code = String(req.body?.device_code || '').trim();
    if (!device_code) {
      return res.status(400).json({ ok: false, error: 'Missing device_code' });
    }
    try {
      const response = await fetch(GH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: GH_CLIENT_ID,
          device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const data = await response.json();

      if (data.access_token) {
        try {
          await storeGhToken(data.access_token);
        } catch (storeErr) {
          console.warn('[gh-auth] token storage warning:', storeErr.message);
        }
        console.log('[gh-auth] Device flow completed successfully');
        return res.json({ ok: true, status: 'success', user: getGhUser() });
      }

      if (data.error === 'authorization_pending') return res.json({ ok: true, status: 'pending' });
      if (data.error === 'slow_down') return res.json({ ok: true, status: 'slow_down', interval: data.interval });
      if (data.error === 'expired_token') return res.json({ ok: true, status: 'expired' });
      if (data.error === 'access_denied') return res.json({ ok: true, status: 'denied' });

      return res.json({ ok: true, status: 'error', error: data.error_description || data.error || 'Unknown error' });
    } catch (err) {
      console.error('[gh-auth] device/poll error:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/gh/auth/status', (req, res) => {
    const user = getGhUser();
    res.json({ ok: true, authenticated: user !== null, user });
  });

  app.post('/api/gh/auth/logout', (req, res) => {
    try {
      execSync('gh auth logout --hostname github.com', { input: '\n', stdio: 'pipe' });
    } catch {}
    console.log('[gh-auth] Logged out');
    res.json({ ok: true });
  });
};

module.exports = { registerGhAuthRoutes };
