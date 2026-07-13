---
name: x-list-ingest
description: Ingest the most recent posts from a configured X (Twitter) list into gbrain, one page per tweet, with author resolution and $TICKER cashtag cross-linking. Composes with gbrain's idea-ingest/ingest author-resolution and cross-linking contracts rather than a narrower one-off spec. Invoked by the hourly x-list-ingest cron with an X list ID.
triggers:
  - "x-list-ingest"
  - "ingest x list"
---

# X List Ingest Skill

> **Filing rule:** Read `skills/_brain-filing-rules.md` (Notability Gate, Iron Law back-linking) before creating any new page. This skill composes with — does not duplicate — the author-resolution and cross-linking contracts already defined in the `idea-ingest` and `gbrain-ingest` skills.

## Contract

This skill guarantees, for every tweet ingested:
- A `twitter/post/<tweet_id>` brain page, deduped on existing slug.
- **Author resolution** (per `idea-ingest` step 3 / `gbrain-ingest` step 2): the author is resolved to a `people/<handle>` page — created if none exists and the account clears the Notability Gate in `_brain-filing-rules.md`, or updated with a new timeline entry if a page already exists — cross-linked bidirectionally (Iron Law back-linking).
- **Entity/ticker linking**: explicit `$TICKER` cashtag mentions in the tweet body are linked (`gbrain link`) to their existing brain pages where such pages already exist. Do not force-create a new company/concept page off a single low-context tweet mention. Do not attempt bare company-name matching — cashtags only.
- `links_extracted_at` gets stamped for every page written this run (see Step 4).

## Step 1 — Fetch posts

The trigger message carries the X list ID as `<list_id>`.

```bash
xurl "/2/lists/<list_id>/tweets?tweet.fields=note_tweet,article&max_results=10"
```

`xurl` is a standalone CLI binary — run it directly, not via openclaw. Do not omit `tweet.fields` or the long-form body will be missing.

## Step 2 — Ingest each post

For each post:
- **Primary body** (in priority order): `article.plain_text` if present (X Article), else `note_tweet.text` if present (long-form tweet), else the tweet `text` field. Never concatenate multiple fields.
- Include any quoted or referenced posts inline under a `## Quoted` section, with the author handle and URL resolved from the API response.
- Slug: exactly `twitter/post/<tweet_id>` — no variations, no date suffixes. Skip if already exists. On check error, skip and count as error — never ingest under a different slug.
- Frontmatter: `type=tweet, tweet_id, author (with @), list_id=<list_id>, posted_at (ISO-8601), url=https://twitter.com/<handle>/status/<tweet_id>, tags=[twitter, x-list-ingest], quoted_ids if any`.

## Step 3 — Author resolution and entity linking

Follow this for every post ingested in Step 2 — do not skip even under time pressure:

1. **Author page.** Search brain for `people/<handle>`.
   - Notability Gate (per `_brain-filing-rules.md`): only create a new page if the account is relevant to your work, not every tweet author. This must stay cheap — no follower-count/verified-status/allow-list checks beyond the generic gate.
   - If a page exists: append a timeline entry for this post.
   - If not, and the account clears the gate: create a minimal `people/<handle>` page.
   - Cross-link both directions: the tweet page links to the author page, and the author page links back to the tweet page (Iron Law).
2. **Cashtag linking.** Extract `$TICKER` mentions from the primary body (Step 2). For each cashtag, search the brain for an existing page (`companies/<ticker>` or similar). If found, `gbrain link` the tweet page to it. If no page exists, do nothing — do not create one from a single tweet mention.

## Step 4 — Stamp extraction (end of batch)

After all posts in this run are ingested, run once to stamp `links_extracted_at` on every page written this run:

```bash
gbrain extract all --stale --source db --json
```

(Confirmed directly against the live `gbrain` CLI: `extract <links|timeline|all> --stale --source db` iterates DB-resident pages rather than requiring a git-synced brain repo, since this skill writes pages via `put_page`/`gbrain put`, not markdown files in a git-tracked brain repo.)

## Step 5 — Result block

End your reply with a result block in this exact inline format — no tables, no slugs:

```
X List Ingest — <n> new · <n> skipped · <n> error(s)
```
For each ingested post (one line each): `✅ @handle — "<text preview, max 80 chars, truncate with …>"`
For each error (one line each): `❌ @handle — <reason>`
If skipped count > 0 (one line): `⏭ <n> already in brain`

Example:
```
X List Ingest — 2 new · 7 skipped · 1 error(s)
✅ @alice — "Just shipped something big that changes everything about how we…"
✅ @bob — "Thread on why the old approach was fundamentally broken 🧵"
❌ @carol — check error
⏭ 7 already in brain
```

## Anti-Patterns

- Re-specifying a narrower author/entity contract instead of following `idea-ingest`/`gbrain-ingest`.
- Force-creating a `people/` page for every tweet author regardless of the Notability Gate.
- Bare company-name entity matching (cashtags only).
- Skipping Step 4 — a page written but never extracted stays permanently `links_extracted_at IS NULL`.
