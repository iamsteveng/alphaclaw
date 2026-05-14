'use strict';

const { spawnSync } = require('child_process');
const { createAuthProfiles } = require('./auth-profiles');
const { AUTH_PROFILES_PATH } = require('./constants');

const X_OAUTH1_PROFILE_ID = 'x-twitter:oauth1';

const runXurl = (args) => {
  // Prefer npx so xurl works whether installed globally or as a local dep
  let result = spawnSync('xurl', args, { encoding: 'utf8', timeout: 15000 });
  if (result.error) {
    result = spawnSync('npx', ['--yes', '@xdevplatform/xurl', ...args], {
      encoding: 'utf8',
      timeout: 30000,
    });
  }
  return result;
};

const configureXurl = ({ consumerKey, consumerSecret, accessToken, accessSecret }) => {
  const result = runXurl([
    'auth', 'oauth1',
    '--consumer-key', consumerKey,
    '--consumer-secret', consumerSecret,
    '--access-token', accessToken,
    '--token-secret', accessSecret,
  ]);
  if (result.error || result.status !== 0) {
    console.warn(
      '[x-twitter] xurl configuration skipped:',
      result.error?.message || result.stderr?.trim() || `exit ${result.status}`,
    );
    return false;
  }
  console.log('[x-twitter] xurl configured with OAuth 1.0a credentials');
  return true;
};

const ensureXTwitterAuth = () => {
  const authProfiles = createAuthProfiles();

  // Priority 1: credentials already stored in auth-profiles (set via dashboard)
  const profile = authProfiles.getProfile(X_OAUTH1_PROFILE_ID);
  if (profile?.key && profile?.token && profile?.access && profile?.refresh) {
    console.log(`[x-twitter] OAuth 1.0a credentials found for @${profile.username || 'unknown'}, configuring xurl`);
    configureXurl({
      consumerKey: profile.key,
      consumerSecret: profile.token,
      accessToken: profile.access,
      accessSecret: profile.refresh,
    });
    return;
  }

  // Priority 2: env vars (existing Railway instances)
  const consumerKey = process.env.X_API_KEY || '';
  const consumerSecret = process.env.X_API_SECRET || '';
  const accessToken = process.env.X_ACCESS_TOKEN || '';
  const accessSecret = process.env.X_ACCESS_TOKEN_SECRET || '';

  if (consumerKey && consumerSecret && accessToken && accessSecret) {
    // Store to auth-profiles so the dashboard shows the connected state
    authProfiles.upsertProfile(X_OAUTH1_PROFILE_ID, {
      type: 'oauth',
      provider: 'x-twitter',
      key: consumerKey,
      token: consumerSecret,
      access: accessToken,
      refresh: accessSecret,
    });
    console.log('[x-twitter] OAuth 1.0a credentials loaded from env vars');
    configureXurl({ consumerKey, consumerSecret, accessToken, accessSecret });
    return;
  }

  console.warn(
    '[x-twitter] X auth unconfigured ' +
    '(set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET ' +
    'or authenticate via the dashboard)',
  );
};

module.exports = { configureXurl, ensureXTwitterAuth };
