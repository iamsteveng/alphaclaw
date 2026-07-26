#!/usr/bin/env node
'use strict';

// x-post-crawl — free (unofficial) single-post/article reader for the
// x-post-ingest skill. See docs/adr/0001-free-x-list-crawler-via-cookie-session.md.
//
//   x-post-crawl <x-url-or-tweet-id>
//
// Reads the stored x-twitter:web-session cookie profile, fetches one post via
// X's internal endpoint (rettiwt-api), and prints normalized JSON to stdout:
//   { tweet_id, author, author_name, text, posted_at, url, quoted,
//     is_article, [article_title, article_preview, article_body, article_blocks] }
//
// Long-form tweets come through `text` (note_tweet resolved). X Articles carry
// the full reconstructed body in `article_body`. On any failure it exits
// non-zero with the error on stderr — no retry, no fallback to the paid API.

const {
  X_WEB_SESSION_PROFILE_ID,
  fetchPostByUrl,
} = require('../lib/server/x-web-session');

const parseArgs = (argv) => {
  const args = { url: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (!args.url) args.url = a;
  }
  return args;
};

const loadApiKey = () => {
  const { createAuthProfiles } = require('../lib/server/auth-profiles');
  const profile = createAuthProfiles().getProfile(X_WEB_SESSION_PROFILE_ID);
  if (!profile?.access) {
    throw new Error(
      'no X web session configured: connect a cookie session in the dashboard ' +
        '(Models → X Free Crawl card)',
    );
  }
  // apiKey is stored pre-built in the profile's `access` field.
  return profile.access;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) {
    process.stderr.write(
      'usage: x-post-crawl <x-url-or-tweet-id>\n' +
        'example: x-post-crawl https://x.com/handle/status/1234567890\n',
    );
    process.exit(args.help ? 0 : 1);
  }
  const result = await fetchPostByUrl({ url: args.url, apiKey: loadApiKey() });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`x-post-crawl: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
