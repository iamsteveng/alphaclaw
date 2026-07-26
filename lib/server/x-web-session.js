'use strict';

// Free (unofficial) X list crawler — cookie-based web session.
// See docs/adr/0001-free-x-list-crawler-via-cookie-session.md.
//
// This does NOT use the OAuth1 X API (that path is metered/paid). It reuses a
// logged-in browser session's cookies to call X's internal GraphQL endpoints
// via rettiwt-api. Credentials live in the x-twitter:web-session auth profile.

const { Rettiwt } = require('rettiwt-api');

const X_WEB_SESSION_PROFILE_ID = 'x-twitter:web-session';

// rettiwt's "apiKey" is base64 of a cookie string; the constructor extracts the
// user id from the twid cookie (`twid="u=<digits>"`). We therefore need
// auth_token, ct0 and twid at minimum; kdt is included when supplied (it helps
// rettiwt rotate the CSRF token and extends session longevity).

const extractTwidUserId = (raw) => {
  const s = String(raw ?? '');
  // Accept either a bare twid value ("u=123" / "u%3D123") or a full decoded
  // cookie string. When given a cookie string, isolate the twid cookie first —
  // otherwise a 4+ digit run inside auth_token or ct0 would be mistaken for the
  // user id (verifyWebSession passes the whole cookie string).
  const twidCookie = s.match(/twid=([^;]+)/);
  const twidVal = twidCookie ? twidCookie[1] : s;
  const match = twidVal.match(/\d{4,}/);
  return match ? match[0] : null;
};

const buildCookieString = ({ authToken, ct0, kdt, twid }) => {
  const userId = extractTwidUserId(twid);
  if (!authToken || !ct0 || !userId) {
    throw new Error(
      'auth_token, ct0 and twid (containing the numeric user id) are all required',
    );
  }
  const parts = [
    `auth_token=${authToken}`,
    `ct0=${ct0}`,
    ...(kdt ? [`kdt=${kdt}`] : []),
    `twid="u=${userId}"`,
  ];
  return `${parts.join(';')};`;
};

const buildApiKey = (cookies) =>
  Buffer.from(buildCookieString(cookies)).toString('base64');

// ── Normalization ────────────────────────────────────────────────────────────
// Map a rettiwt Tweet into the flat shape the x-list-ingest skill consumes.
// Tweet.fullText already falls back from note_tweet (long-form) to the legacy
// body, so long-form posts arrive complete. Known gap: X Articles expose only
// their tweet text here, not the full article body (see ADR — that is the
// documented trigger for escalating to the Playwright XHR-capture hybrid).

const quotedRef = (quoted) =>
  quoted
    ? {
        author: quoted.tweetBy?.userName ? `@${quoted.tweetBy.userName}` : null,
        text: quoted.fullText ?? '',
        url: quoted.url ?? null,
      }
    : null;

const normalizePost = (tweet) => {
  const q = quotedRef(tweet.quoted);
  return {
    tweet_id: tweet.id,
    author: tweet.tweetBy?.userName ? `@${tweet.tweetBy.userName}` : null,
    author_name: tweet.tweetBy?.fullName ?? null,
    text: tweet.fullText ?? '',
    posted_at: tweet.createdAt ?? null,
    url: tweet.url ?? null,
    quoted: q ? [q] : [],
  };
};

// ── Network ──────────────────────────────────────────────────────────────────
// RettiwtCtor is injectable so tests can drive the mapping without the network.

const fetchListTweets = async ({
  listId,
  maxResults = 10,
  apiKey,
  RettiwtCtor = Rettiwt,
}) => {
  if (!listId) throw new Error('listId is required');
  if (!apiKey) throw new Error('apiKey is required');
  const rettiwt = new RettiwtCtor({ apiKey });
  const result = await rettiwt.list.tweets(String(listId), maxResults);
  const list = result?.list ?? [];
  return { list_id: String(listId), count: list.length, posts: list.map(normalizePost) };
};

// Live liveness probe for stored cookies: resolve the session's own account.
// Returns { userId, username, name }. Throws if the session is dead/invalid.
const verifyWebSession = async ({ apiKey, RettiwtCtor = Rettiwt }) => {
  const cookieString = Buffer.from(apiKey, 'base64').toString('ascii');
  const userId = extractTwidUserId(cookieString);
  if (!userId) throw new Error('stored session is missing a valid twid user id');
  const rettiwt = new RettiwtCtor({ apiKey });
  const me = await rettiwt.user.details(userId);
  if (!me?.id) throw new Error('X rejected the session cookies (login expired?)');
  return { userId: me.id, username: me.userName, name: me.fullName };
};

module.exports = {
  X_WEB_SESSION_PROFILE_ID,
  extractTwidUserId,
  buildCookieString,
  buildApiKey,
  normalizePost,
  fetchListTweets,
  verifyWebSession,
};
