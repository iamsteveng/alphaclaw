'use strict';

const crypto = require('crypto');

const X_OAUTH1_PROFILE_ID = 'x-twitter:oauth1';
const X_API_BASE = 'https://api.twitter.com/2';

// ── OAuth 1.0a HMAC-SHA1 signing ──────────────────────────────────────────────
// Spec: https://oauth.net/core/1.0a/#signing_process
// Query params MUST be included in the parameter string (proven in POC tests).

const pct = (s) =>
  encodeURIComponent(String(s)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const buildOAuth1Header = ({
  method,
  url,
  consumerKey,
  consumerSecret,
  accessToken,
  accessSecret,
  queryParams = {},
}) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const ts = Math.floor(Date.now() / 1000).toString();
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: ts,
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const allParams = { ...oauthParams, ...queryParams };
  const paramStr = Object.entries(allParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join('&');
  const sigBase = [method.toUpperCase(), pct(url), pct(paramStr)].join('&');
  const sigKey = `${pct(consumerSecret)}&${pct(accessSecret)}`;
  const sig = crypto.createHmac('sha1', sigKey).update(sigBase).digest('base64');
  oauthParams.oauth_signature = sig;
  return (
    'OAuth ' +
    Object.entries(oauthParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
      .join(', ')
  );
};

const verifyOAuth1Creds = async ({ consumerKey, consumerSecret, accessToken, accessSecret }) => {
  const url = `${X_API_BASE}/users/me`;
  const header = buildOAuth1Header({
    method: 'GET',
    url,
    consumerKey,
    consumerSecret,
    accessToken,
    accessSecret,
  });
  console.log('[x-twitter:debug] ck_len=%d at_len=%d cs_len=%d as_len=%d',
    consumerKey.length, accessToken.length, consumerSecret.length, accessSecret.length);
  const res = await fetch(url, { headers: { Authorization: header } });
  const rawBody = await res.text();
  console.log('[x-twitter:debug] status=%d body=%s', res.status, rawBody.slice(0, 200));
  const json = (() => { try { return JSON.parse(rawBody); } catch { return {}; } })();
  if (!res.ok) {
    throw new Error(
      `X API rejected credentials (HTTP ${res.status}): ${json?.detail || json?.errors?.[0]?.message || ''}`,
    );
  }
  return { id: json.data?.id, username: json.data?.username };
};

const registerXTwitterRoutes = ({ app, authProfiles }) => {
  // POST /api/x/auth
  // Body: { consumerKey, consumerSecret, accessToken, accessSecret }
  app.post('/api/x/auth', async (req, res) => {
    const { consumerKey, consumerSecret, accessToken, accessSecret } = req.body || {};
    if (!consumerKey || !consumerSecret || !accessToken || !accessSecret) {
      return res.status(400).json({
        ok: false,
        error: 'All four credentials are required: consumerKey, consumerSecret, accessToken, accessSecret',
      });
    }
    const creds = {
      consumerKey: String(consumerKey).trim(),
      consumerSecret: String(consumerSecret).trim(),
      accessToken: String(accessToken).trim(),
      accessSecret: String(accessSecret).trim(),
    };
    try {
      const { id, username } = await verifyOAuth1Creds(creds);
      authProfiles.upsertProfile(X_OAUTH1_PROFILE_ID, {
        type: 'oauth',
        provider: 'x-twitter',
        key: creds.consumerKey,
        token: creds.consumerSecret,
        access: creds.accessToken,
        refresh: creds.accessSecret,
        userId: id,
        username,
      });
      console.log(`[x-twitter] OAuth 1.0a credentials stored. User: @${username} (id=${id})`);
      return res.json({ ok: true, username, userId: id });
    } catch (err) {
      console.error('[x-twitter] Credential validation failed:', err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // GET /api/x/auth/status
  app.get('/api/x/auth/status', (req, res) => {
    const profile = authProfiles.getProfile(X_OAUTH1_PROFILE_ID);
    if (!profile?.key) return res.json({ configured: false });
    return res.json({
      configured: true,
      username: profile.username || null,
      userId: profile.userId || null,
      keyPreview: profile.key.slice(0, 8) + '...',
    });
  });

  // POST /api/x/auth/verify
  // Live-tests stored credentials against the X API
  app.post('/api/x/auth/verify', async (req, res) => {
    const profile = authProfiles.getProfile(X_OAUTH1_PROFILE_ID);
    if (!profile?.key) {
      return res.status(400).json({ ok: false, error: 'No X credentials configured' });
    }
    try {
      const { username, id } = await verifyOAuth1Creds({
        consumerKey: profile.key,
        consumerSecret: profile.token,
        accessToken: profile.access,
        accessSecret: profile.refresh,
      });
      return res.json({ ok: true, username, userId: id });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // DELETE /api/x/auth
  app.delete('/api/x/auth', (req, res) => {
    authProfiles.removeProfile(X_OAUTH1_PROFILE_ID);
    console.log('[x-twitter] OAuth 1.0a credentials removed');
    return res.json({ ok: true });
  });
};

module.exports = { registerXTwitterRoutes };
