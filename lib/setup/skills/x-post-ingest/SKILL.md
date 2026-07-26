---
name: x-post-ingest
description: Ingest a single X (Twitter) post, long-form tweet, or X Article into gbrain from its URL — one page per post, with full article-body extraction, author resolution, and $TICKER cashtag cross-linking. Produces the same page shape as x-list-ingest, so a post ingested by URL dedups with one the list cron already ingested.
triggers:
  - "x-post-ingest"
  - "ingest x post"
  - "ingest x article"
  - "ingest this tweet"
  - "ingest this x post"
  - "ingest this x url"
---

# X Post Ingest Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` (Notability Gate, Iron Law back-linking) before creating any new page. This skill composes with — does not duplicate — the author-resolution and cross-linking contracts defined in the `idea-ingest`, `gbrain-ingest`, and `x-list-ingest` skills. The page it writes is **identical in shape** to what `x-list-ingest` produces for the same tweet, so the two dedup to a single `twitter/post/<tweet_id>` page.

## Contract

For the one post identified by the URL in the trigger message:
- A `twitter/post/<tweet_id>` brain page, deduped on existing slug.
- **Author resolution** (per `x-list-ingest` Step 3): the author is resolved to a `people/<handle>` page — created if none exists and the account clears the Notability Gate, or updated with a new timeline entry — cross-linked bidirectionally (Iron Law).
- **Entity/ticker linking**: explicit `$TICKER` cashtags in the body are `gbrain link`ed to their existing brain pages where such pages already exist. Cashtags only; never bare company-name matching; never force-create a page off one mention.
- `links_extracted_at` gets stamped for the page written this run (see Step 4).

## Step 1 — Fetch the post

The trigger message contains an X URL (or a raw tweet ID). Extract it and run:

```bash
x-post-crawl "<x-url-or-tweet-id>"
```

`x-post-crawl` is a standalone CLI binary on PATH — run it directly, not via openclaw. It reads the post through the stored cookie session (no paid X API) and prints one normalized JSON object:

```json
{ "tweet_id": "…", "author": "@handle", "author_name": "…",
  "text": "post body (long-form resolved)", "posted_at": "ISO-8601",
  "url": "https://x.com/handle/status/…", "quoted": [ … ],
  "is_article": true, "article_title": "…", "article_preview": "…",
  "article_body": "full reconstructed article text", "article_blocks": 73 }
```

`is_article` is `false` for ordinary and long-form posts (the fields after it are then absent). On failure `x-post-crawl` exits non-zero with the error on stderr — report that in the result block; do not fall back to any other fetch method.

## Step 2 — Ingest the post

- **Primary body**:
  - If `is_article` is `false`: the `text` field (already carries the full long-form body).
  - If `is_article` is `true`: compose the page body as the `article_title` (as a heading) followed by the full `article_body`. Include the tweet's own `text` as a short lead-in only if non-empty.
- Include any entries in the `quoted` array inline under a `## Quoted` section (author, text, url).
- Slug: exactly `twitter/post/<tweet_id>` — no variations, no date suffixes. If it already exists, update it in place rather than creating a duplicate. On check error, skip and count as error — never ingest under a different slug.
- Frontmatter: `type=tweet, tweet_id, author (with @), posted_at (ISO-8601), url, tags=[twitter, x-post-ingest]`. For an article, also set `is_article=true`, `article_title`, and add `x-article` to `tags`.

## Step 3 — Author resolution and entity linking

Follow `x-list-ingest` Step 3 exactly (do not re-specify a narrower contract):
1. **Author page** — resolve `people/<handle>`; honor the Notability Gate; append a timeline entry if it exists, else create if the account clears the gate; cross-link both directions (Iron Law).
2. **Cashtag linking** — extract `$TICKER` mentions from the primary body; `gbrain link` to an existing `companies/<ticker>` page where present; do nothing if no page exists.

## Step 4 — Stamp extraction

After the page is written, stamp `links_extracted_at`:

```bash
gbrain extract all --stale --source db --json
```

## Step 5 — Result block

End your reply with a result block in this exact inline format:

```
X Post Ingest — <new|updated|skipped|error>
```
Then one line: `✅ @handle — "<text or article title preview, max 80 chars, truncate with …>"` (or `❌ @handle — <reason>` on error).

Example:
```
X Post Ingest — new
✅ @a16z — "Renting is stressful. Millions of renter conversations tell us why."
```

## Anti-Patterns

- Re-specifying a narrower author/entity contract instead of following `x-list-ingest`/`idea-ingest`.
- Creating a separate slug namespace for URL-ingested posts (breaks dedup with the list cron — always `twitter/post/<tweet_id>`).
- Storing only the article title/preview when `article_body` is present — ingest the full body.
- Falling back to another fetch method when `x-post-crawl` fails — report the error instead.
