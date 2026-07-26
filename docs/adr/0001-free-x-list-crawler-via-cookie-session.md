---
status: accepted
---

# Free X list crawler via a cookie web session, not the official API

AlphaClaw already stores OAuth1 X API credentials and could read lists through the official v2 API — but that API's read access is metered/paid (the account hit HTTP 402 "credits depleted"), and there is no free official read tier. We chose to crawl the X list for **free instead**, using a logged-in browser session's cookies (`auth_token` + `ct0` + `twid`, optionally `kdt`) to call X's internal GraphQL endpoints via `rettiwt-api`. A new `x-list-crawl` CLI reads a stored `x-twitter:web-session` auth profile and emits normalized JSON; the `x-list-ingest` skill calls it instead of the paid path.

## Considered options

- **Official v2 API (OAuth1 / xurl)** — rejected: not free (metered, currently out of credits).
- **Nitter** — rejected: X killed the guest-account API it relied on; public instances are dead/broken.
- **Cookie-based unofficial client (`rettiwt-api`)** — chosen: smallest change to the existing skill (it already parses this JSON shape), lowest resource cost, actively maintained.
- **Playwright + XHR capture** — held in reserve as the documented escalation path if `rettiwt-api` churn or X-Article fidelity makes the client inadequate.
- **Pure DOM scraping** — rejected: highest maintenance for the least structured output.

## Consequences

- **This violates X's Terms of Service and risks suspension of the account whose session is used.** A burner/secondary account is the intended credential source, to isolate that risk from the operator's main account. This trade-off was accepted knowingly.
- No password is stored — only the session cookies, pre-encoded into `rettiwt-api`'s base64 apiKey and kept in the `x-twitter:web-session` profile. Sessions die on logout/password-change/suspension and must be re-pasted (order of months).
- **X Articles** — the `x-list-crawl` path only surfaces the tweet text, not the article body. **Update (x-post-ingest):** the full article body *is* recoverable from the raw payload at `article.article_results.result.content_state.blocks[].text` (verified live — reconstructed a 15,895-char a16z article). `fetchPostByUrl`/`x-post-crawl` extract it via `findArticle`/`reconstructArticle`; no Playwright fallback was needed. The list path (`x-list-crawl`) can adopt the same helpers as a follow-up to close its gap too.
- Failures are loud (non-zero exit, error to stderr); there is deliberately **no automatic fallback to the official API**, so a dead session surfaces in the cron run rather than silently switching to the paid path.
- The OAuth1 credential store and dashboard card are retained (harmless, useful if API credits ever return); only the fetch path for list ingest moved off it.
