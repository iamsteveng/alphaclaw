#!/usr/bin/env node
'use strict';

// x-list-crawl — free (unofficial) X list reader for the x-list-ingest skill.
// See docs/adr/0001-free-x-list-crawler-via-cookie-session.md.
//
//   x-list-crawl <list_id> [--max N]
//
// Reads the stored x-twitter:web-session cookie profile, calls X's internal
// list-tweets endpoint via rettiwt-api, and prints normalized JSON to stdout:
//   { "list_id": "...", "count": N, "posts": [ { tweet_id, author, ... } ] }
//
// On any failure it exits non-zero with the error on stderr. There is
// deliberately no retry and no fallback to the official (paid) API.

const {
  X_WEB_SESSION_PROFILE_ID,
  buildApiKey,
  fetchListTweets,
} = require('../lib/server/x-web-session');

const parseArgs = (argv) => {
  const args = { listId: null, maxResults: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--max' || a === '-n') {
      args.maxResults = parseInt(argv[++i], 10);
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (!args.listId) {
      args.listId = a;
    }
  }
  if (!Number.isFinite(args.maxResults) || args.maxResults <= 0) {
    args.maxResults = 10;
  }
  return args;
};

const loadApiKey = () => {
  const { createAuthProfiles } = require('../lib/server/auth-profiles');
  const profile = createAuthProfiles().getProfile(X_WEB_SESSION_PROFILE_ID);
  if (!profile?.access) {
    throw new Error(
      'no X web session configured: connect a cookie session in the dashboard ' +
        '(Models → X card → "Free crawl (cookie session)")',
    );
  }
  // apiKey is stored pre-built in the profile's `access` field.
  return profile.access;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.listId) {
    process.stderr.write(
      'usage: x-list-crawl <list_id> [--max N]\n' +
        'example: x-list-crawl 1234567890 --max 10\n',
    );
    process.exit(args.help ? 0 : 1);
  }
  const result = await fetchListTweets({
    listId: args.listId,
    maxResults: args.maxResults,
    apiKey: loadApiKey(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`x-list-crawl: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
