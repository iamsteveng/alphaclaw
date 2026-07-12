# x-list-ingest writes tweets to gbrain without link extraction or entity cross-linking — Requirements

## Goals

- `x-list-ingest` exists as a proper, discoverable OpenClaw workspace skill at `lib/setup/skills/x-list-ingest/SKILL.md`, matching this repo's documented skill-installation pattern (frontmatter `name`, `description`, `triggers`), and is present under `workspace/skills/x-list-ingest/` on the live `prod-peter` (and any other) OpenClaw instance after the next deploy/restart — the same way the 9 existing bundled skills (`eod-loop`, `watchlist-builder`, `trading-framework`, etc.) already are.
- The hourly cron's message (`buildIngestMessage()` in `lib/server/routes/x-list-ingest.js`) no longer embeds the full ingestion contract inline. Instead it is a short message that matches one of the new skill's `triggers` and carries only the per-run parameter (the X list ID), so the skill itself — not a re-typed inline string — defines ingestion behavior.
- For each tweet ingested by an `x-list-ingest` run, the same two outcomes gbrain's own `idea-ingest`/`ingest` skills already guarantee for other content happen automatically:
  - **Author resolution.** The tweet's author is resolved to a `people/<handle>` brain page (created if none exists and the account clears the notability gate in `_brain-filing-rules.md`; updated with a new timeline entry if a page already exists), cross-linked bidirectionally between the tweet page and the author page (Iron Law back-linking).
  - **Entity/ticker linking.** `$TICKER` symbols and known company names mentioned in the tweet body are linked to their existing brain pages where such pages already exist (no new company/concept pages are force-created off a single low-context tweet mention).
- The skill composes with (invokes/follows) gbrain's existing `idea-ingest` and `ingest` skill contracts for this per-post write, rather than re-specifying a narrower, disconnected frontmatter-only contract — so future improvements to gbrain's ingest/linking behavior apply to `x-list-ingest` for free.
- Each batch ends with a `gbrain sync` (or the appropriate stale-extraction command — see "When You Need Human Feedback" for the exact flag/subcommand to confirm) so that `pages.links_extracted_at` gets stamped on every tweet page written that run — pages are no longer permanently stuck at `NULL`.
- The pre-existing backlog of 1,846 already-ingested `twitter/post/*` pages gets backfilled so the same linking/extraction outcomes apply retroactively, not just to new ingests going forward.
- Observable end state, from an operator/data perspective: querying the live Postgres-backed brain after a fresh `x-list-ingest` cron run shows non-null `links_extracted_at` and at least one outbound link for each newly-ingested tweet page (barring genuine no-link, no-notable-author tweets), and the historical `twitter/post/%` backlog's NULL-`links_extracted_at` count is materially reduced from 1,846.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

- [ ] `lib/setup/skills/x-list-ingest/SKILL.md` exists with valid frontmatter (`name: x-list-ingest`, non-empty `description`, non-empty `triggers` array).
  ```bash
  node -e "
  const fs = require('fs');
  const path = 'lib/setup/skills/x-list-ingest/SKILL.md';
  if (!fs.existsSync(path)) { console.error('SKILL.md missing'); process.exit(1); }
  const content = fs.readFileSync(path, 'utf8');
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { console.error('No frontmatter block'); process.exit(1); }
  const yaml = fm[1];
  if (!/^name:\s*x-list-ingest\s*$/m.test(yaml)) { console.error('Missing/wrong name field'); process.exit(1); }
  if (!/^description:\s*\S/m.test(yaml)) { console.error('Missing description'); process.exit(1); }
  if (!/^triggers:\s*$/m.test(yaml) || !/^\s*-\s*\S/m.test(yaml.split('triggers:')[1] || '')) {
    console.error('Missing/empty triggers list'); process.exit(1);
  }
  console.log('OK');
  "
  ```

- [ ] `syncWorkspaceSkills` (`lib/server/onboarding/workspace.js`) copies the new skill directory into a target workspace, same as every other bundled skill.
  ```bash
  node -e "
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { syncWorkspaceSkills } = require('./lib/server/onboarding/workspace');
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-skills-'));
  syncWorkspaceSkills({ fs, workspaceDir });
  const dest = path.join(workspaceDir, 'skills', 'x-list-ingest', 'SKILL.md');
  if (!fs.existsSync(dest)) { console.error('x-list-ingest not synced to workspace/skills'); process.exit(1); }
  console.log('OK');
  "
  ```
  (If `syncWorkspaceSkills` is not directly exported/importable at implementation time, add the export — do not skip this check by testing a private code path.)

- [ ] Live/deployed confirmation: after restart, the skill is present under the running OpenClaw gateway's actual workspace directory (`HOME=/data`), not just AlphaClaw's own repo copy.
  ```bash
  docker exec "${CONTAINER:-openclaw-railway-template-openclaw-1}" \
    test -f /data/.openclaw/workspace/skills/x-list-ingest/SKILL.md \
    && echo OK || (echo "FAIL: skill not present in live workspace"; exit 1)
  ```

- [ ] `buildIngestMessage()` no longer embeds the full per-post ingestion contract (frontmatter field list, result-block format spec) inline — it is short and contains a phrase matching one of the new skill's `triggers`, plus the list ID.
  ```bash
  node -e "
  const { readFileSync } = require('fs');
  const src = readFileSync('lib/server/routes/x-list-ingest.js', 'utf8');
  const fm = readFileSync('lib/setup/skills/x-list-ingest/SKILL.md', 'utf8');
  const triggersBlock = (fm.match(/triggers:\s*\n((?:\s*-.*\n?)+)/) || [,''])[1];
  const triggers = [...triggersBlock.matchAll(/-\s*[\"']?([^\"'\n]+)[\"']?/g)].map((m) => m[1].trim());
  const buildFnMatch = src.match(/buildIngestMessage\s*=\s*\([^)]*\)\s*=>\s*\`([\s\S]*?)\`;/);
  if (!buildFnMatch) { console.error('Could not locate buildIngestMessage template'); process.exit(1); }
  const msg = buildFnMatch[1];
  const matchesTrigger = triggers.some((t) => msg.toLowerCase().includes(t.toLowerCase()));
  if (!matchesTrigger) { console.error('Message does not contain any skill trigger phrase:', triggers); process.exit(1); }
  if (/tags=\[twitter, x-list-ingest\]/.test(msg) && /Each page frontmatter:/.test(msg)) {
    console.error('Full inline ingestion contract still present in buildIngestMessage()'); process.exit(1);
  }
  if (msg.length > 600) { console.error('Message still looks like the old inline contract (too long):', msg.length, 'chars'); process.exit(1); }
  console.log('OK — message is short and trigger-matched:', JSON.stringify(msg));
  "
  ```

- [ ] `npm test` passes with no new failures.
  ```bash
  npm test 2>&1 | tail -20
  ```

- [ ] End-to-end, against the live container + Postgres-backed brain: running the `x-list-ingest` cron produces newly-ingested tweet pages with non-null `links_extracted_at` and at least one outbound link, and at least one author `people/` page is created or updated with a bidirectional link.
  ```bash
  # Follow the pattern in scripts/tests/test-eod-loop.sh / verify-gbrain-postgres.sh:
  # trigger the cron via its API, wait for the agent turn to finish, then assert via SQL.
  curl -s -b /tmp/ac.txt -X POST "http://localhost:${PORT:-3001}/api/x-list-ingest/ensure" \
    -H "Content-Type: application/json" -d '{}' > /dev/null
  # (trigger a manual run via cron.run RPC or the equivalent /api endpoint, then wait)
  sleep 150

  PG_CONTAINER="${PG_CONTAINER:-openclaw-railway-template-postgres-1}"

  NEW_NULL_COUNT=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -tAc "
    SELECT count(*) FROM pages
    WHERE slug LIKE 'twitter/post/%'
      AND updated_at > now() - interval '10 minutes'
      AND links_extracted_at IS NULL;
  ")
  if [ "$NEW_NULL_COUNT" -ne 0 ]; then
    echo "FAIL: $NEW_NULL_COUNT newly-ingested tweet pages still have links_extracted_at = NULL"; exit 1
  fi

  NEW_WITH_LINKS=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -tAc "
    SELECT count(DISTINCT p.id) FROM pages p JOIN links l ON l.from_page_id = p.id
    WHERE p.slug LIKE 'twitter/post/%' AND p.updated_at > now() - interval '10 minutes';
  ")
  if [ "$NEW_WITH_LINKS" -eq 0 ]; then
    echo "FAIL: none of this run's newly-ingested tweet pages have any outbound link"; exit 1
  fi

  echo "OK — $NEW_WITH_LINKS newly-ingested tweet page(s) have links_extracted_at set and at least one outbound link"
  ```

- [ ] Backfill materially reduces the existing 1,846-page NULL-`links_extracted_at` backlog (must not be a no-op skip — must actually run against the live corpus and be re-checked by SQL count).
  ```bash
  PG_CONTAINER="${PG_CONTAINER:-openclaw-railway-template-postgres-1}"
  BEFORE=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -tAc "
    SELECT count(*) FROM pages WHERE slug LIKE 'twitter/post/%' AND links_extracted_at IS NULL;
  ")
  echo "Backlog before: $BEFORE"

  # (run the backfill command chosen during implementation here)

  AFTER=$(docker exec "$PG_CONTAINER" psql -U postgres -d gbrain -tAc "
    SELECT count(*) FROM pages WHERE slug LIKE 'twitter/post/%' AND links_extracted_at IS NULL;
  ")
  echo "Backlog after: $AFTER"
  if [ "$AFTER" -ge "$BEFORE" ]; then
    echo "FAIL: backfill did not reduce the NULL links_extracted_at backlog ($BEFORE -> $AFTER)"; exit 1
  fi
  echo "OK — backlog reduced from $BEFORE to $AFTER"
  ```

## Constraints

- Do not create a new, narrower ingestion contract that duplicates gbrain's `idea-ingest`/`ingest` author-resolution and cross-linking logic — the skill must compose with (reference/invoke) those existing skills, per the issue's explicit decision to fix this structurally rather than patch symptoms.
- Do not force-create a `people/<handle>` page for every tweet author regardless of signal — gate creation behind the notability heuristic already defined in `skills/_brain-filing-rules.md` ("Notability Gate" section), so low-signal/bot accounts don't pollute the graph. This must stay cheap enough for a high-volume hourly cron (up to 10 tweets/run).
- Do not change the existing `twitter/post/<tweet_id>` slug convention, the dedupe-on-existing-slug behavior, or the quoted/referenced-post inline handling already specified in the current `buildIngestMessage()` — those parts of current behavior are correct and out of scope for this fix.
- Do not change the cron's schedule (`0 * * * *` UTC), `sessionTarget`, `wakeMode`, or the `/api/x-list-ingest/*` route contracts (`status`, `ensure`, `DELETE`) in `lib/server/routes/x-list-ingest.js` — this is a content/composition fix to what the cron *instructs the agent to do*, not to how the cron is scheduled or managed.
- Do not modify `.omc/skills/x-list-ingest.md` or `.omc/plans/x-list-ingest*.md` as part of implementing this — per the issue, those are oh-my-claudecode's own unrelated planning artifacts from this feature's original build, not the real OpenClaw-agent-facing skill.
- Do not remove or weaken the existing Telegram/Discord result-block summary format (`X List Ingest — <n> new · <n> skipped · <n> error(s)` etc.) that the cron's delivery relies on — whatever the new short trigger message produces must still result in the agent emitting this same summary format at the end of a run.
- The backfill (Acceptance Criterion 6 in the issue) must run against the real, live `prod-peter` Postgres-backed brain — not a local/mocked dataset — since the 1,846-page backlog figure and the "before/after" verification above are both scoped to that live instance.

## When You Need Human Feedback

- **Exact gbrain command to stamp `links_extracted_at`.** The issue's Task Brief and Reference sections cite `gbrain sync --no-pull --no-embed` and `gbrain extract --stale` / `gbrain extract --stale --catch-up` as the commands that trigger extraction and backfill, and cite a `gbrain docs/architecture/KEY_FILES.md` for the staleness mechanics. I could not independently confirm these exact flags: the only bundled-skill documentation I could find (`skills/conventions/brain-first.md` in a local OpenClaw workspace snapshot) shows `gbrain sync --no-pull` (no `--no-embed`), and no bundled skill anywhere references a `gbrain extract` subcommand at all — it may exist as an undocumented/newer CLI command not reflected in the skill docs I had access to. **@iamsteveng** — before implementation, please run `gbrain sync --help` and `gbrain extract --help` (or equivalent) against the live `prod-peter` container to confirm the exact subcommand/flags for (a) per-run extraction and (b) the historical backfill, so the Verifications above use the real command.
- **Backfill mechanism and blast radius.** The issue asks to "run `gbrain extract --stale --catch-up` (or equivalent) against the 1,846 already-ingested tweet pages." Depending on gbrain's actual implementation, a stale-extraction pass across the whole brain (not scoped to `twitter/post/*`) could be expensive or could pick up unrelated stale pages outside this issue's scope. **@iamsteveng** — confirm whether the backfill should be scoped specifically to `twitter/post/%` slugs (e.g. via a scripted loop calling extraction per-page) or whether a brain-wide `--stale` pass is acceptable/intended.
- **Notability gate specifics for Twitter/X accounts.** `_brain-filing-rules.md`'s "Notability Gate" is generic ("Will you interact with them again? Are they relevant to your work?") and isn't Twitter-specific. The issue's own wording ("low-signal/bot account") implies a more concrete signal (e.g. follower count, verified status, or an allow/deny list) may be wanted for the hourly cron specifically, since an LLM applying the generic gate per-tweet, unsupervised, at up to 10 tweets/hour, may be inconsistent. **@iamsteveng** — confirm whether the generic notability gate is sufficient as-is for this skill, or whether a more concrete X-specific signal should be added.
- **Ticker/company entity-linking scope.** The issue asks for "basic entity ($TICKER / known company) linking" per post but doesn't specify how aggressively to scan tweet bodies (e.g. only explicit `$TICKER` cashtags, or also bare company names/tickers without the `$` prefix, which risks false positives on common words). **@iamsteveng** — confirm whether entity linking should be scoped to explicit `$TICKER` cashtag mentions only, or should also attempt bare company-name matching against existing `companies/` pages.
