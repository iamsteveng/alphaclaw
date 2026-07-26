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
// body, so long-form posts arrive complete. X Articles are not parsed by
// rettiwt, but the full body IS present in the raw payload — see
// findArticle/reconstructArticle below (used by fetchPostByUrl).

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

// ── Single post / article by URL ─────────────────────────────────────────────

// Parse a tweet ID from an x.com/twitter.com status URL, or accept a bare id.
const parseTweetId = (input) => {
  const s = String(input ?? '').trim();
  const fromUrl = s.match(/status\/(\d+)/);
  if (fromUrl) return fromUrl[1];
  return /^\d+$/.test(s) ? s : null;
};

// X Articles aren't parsed by rettiwt, but the raw payload carries the full
// body. The article node lives at `<node>.article.article_results.result` and
// may sit on the tweet itself OR on a quoted/nested status — so search
// recursively. Returns the article result node, or null.
const findArticle = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (node.article?.article_results?.result) return node.article.article_results.result;
  for (const value of Object.values(node)) {
    const found = findArticle(value);
    if (found) return found;
  }
  return null;
};

// Reconstruct an article's body from its Draft.js-style content blocks.
const reconstructArticle = (art) => {
  const blocks = art?.content_state?.blocks ?? [];
  return {
    title: art?.title ?? null,
    preview: art?.preview_text ?? null,
    body: blocks.map((b) => b?.text ?? '').join('\n'),
    blocks: blocks.length,
  };
};

// normalizePost + article fields (only present when the post carries an article).
const normalizePostDetailed = (tweet) => {
  const base = normalizePost(tweet);
  const art = findArticle(tweet?._raw ?? {});
  if (!art) return { ...base, is_article: false };
  const { title, preview, body, blocks } = reconstructArticle(art);
  return {
    ...base,
    is_article: true,
    article_title: title,
    article_preview: preview,
    article_body: body,
    article_blocks: blocks,
  };
};

// ── Network ──────────────────────────────────────────────────────────────────
// RettiwtCtor is injectable so tests can drive the mapping without the network.

const fetchPostByUrl = async ({ url, apiKey, RettiwtCtor = Rettiwt }) => {
  if (!apiKey) throw new Error('apiKey is required');
  const tweetId = parseTweetId(url);
  if (!tweetId) throw new Error(`could not parse a tweet ID from: ${url}`);
  const rettiwt = new RettiwtCtor({ apiKey });
  const tweet = await rettiwt.tweet.details(tweetId);
  if (!tweet?.id) throw new Error(`no post found for tweet ID ${tweetId}`);
  return normalizePostDetailed(tweet);
};

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
  parseTweetId,
  findArticle,
  reconstructArticle,
  normalizePostDetailed,
  fetchPostByUrl,
  fetchListTweets,
  verifyWebSession,
};
