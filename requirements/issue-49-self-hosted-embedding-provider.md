# Set up Ollama/llama-server as self-hosted embedding provider for gbrain — Requirements

## Goals

- `prod-peter`'s gbrain instance embeds content using a self-hosted model (Ollama, `nomic-embed-text` by default) instead of the hosted ZeroEntropy API — no `ZEROENTROPY_API_KEY` (or any other paid embedding-provider key) is required for gbrain to function going forward.
- The embedding model runs as its own Railway service inside the `radiant-liberation` project, reachable from `prod-peter` only over Railway's private network (`*.railway.internal`) — not exposed publicly.
- The existing backlog of stale, never-embedded `content_chunks` (1,946 at the time the issue was filed, larger by implementation time) is fully backfilled under the new provider.
- Local dev (`docker-compose.yml`) gets the same embedding provider available as a service, consistent with this repo's stated goal that "the conditions in local container setup are the same as that in Railway production instance" (see `requirements/connect-postgres-to-gbrain.md`), so a contributor working on gbrain/embedding-adjacent code can reproduce the setup without needing a paid API key either.
- `gbrain query` / `gbrain search` continue to return sensible, non-empty results against the live brain after the model/dimension switch — the migration doesn't silently degrade retrieval into a broken or empty-result state.
- Fresh installs (new environment, disaster recovery, empty `/data` volume) do not regress into the original bug — i.e. a brand-new deployment doesn't end up defaulting to an embedding provider with no key set and silently sitting at 0% embedded, the way `prod-peter` did.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

- [ ] Local: `docker-compose.yml` defines an `ollama` (or `llama-server`) service that the `openclaw` service can reach, and the model is pulled/available.
  ```bash
  docker compose up -d
  CONTAINER="${CONTAINER:-openclaw-railway-template-openclaw-1}"
  docker exec "$CONTAINER" bash -c "curl -sf http://ollama:11434/api/tags | grep -q nomic-embed-text" \
    && echo OK || (echo "FAIL: ollama service unreachable or model not pulled"; exit 1)
  ```

- [ ] Local: `HOME=/data gbrain providers test --model ollama:nomic-embed-text` succeeds inside the `openclaw` container (confirms the recipe + local network path both work end-to-end, not just that the HTTP port answers).
  ```bash
  CONTAINER="${CONTAINER:-openclaw-railway-template-openclaw-1}"
  docker exec "$CONTAINER" bash -c "HOME=/data gbrain providers test --model ollama:nomic-embed-text" \
    && echo OK || (echo "FAIL: gbrain providers test failed against local ollama"; exit 1)
  ```

- [ ] Production: a Railway service running Ollama (or llama-server) exists in the `radiant-liberation` project and is reachable from `prod-peter` over the private network.
  ```bash
  railway service list --project radiant-liberation --json | grep -qiE '"name":\s*"(ollama|llama-server)"' \
    && echo OK || (echo "FAIL: no ollama/llama-server service found in radiant-liberation"; exit 1)

  # Reachability from prod-peter itself, not just "the service exists":
  railway run --service prod-peter -- bash -c 'curl -sf "$OLLAMA_BASE_URL/api/tags" || curl -sf "${OLLAMA_BASE_URL%/v1}/tags"' \
    && echo OK || (echo "FAIL: prod-peter cannot reach the ollama service over the private network"; exit 1)
  ```

- [ ] Production: `prod-peter`'s env has `OLLAMA_BASE_URL` (or `LLAMA_SERVER_BASE_URL`) set, and no longer needs `ZEROENTROPY_API_KEY` for gbrain to embed.
  ```bash
  railway variables --service prod-peter --json | python3 -c "
  import json, sys
  v = json.load(sys.stdin)
  assert v.get('OLLAMA_BASE_URL') or v.get('LLAMA_SERVER_BASE_URL'), 'FAIL: no OLLAMA_BASE_URL/LLAMA_SERVER_BASE_URL set'
  print('OK')
  "
  ```

- [ ] Production: gbrain's file-plane config (`~/.gbrain/config.json` on `prod-peter`, read via `gbrain config get`) is pinned to the new provider/dimension pair — not left on the old `zeroentropyai:zembed-1`/1280 config that was never actually populated.
  ```bash
  railway run --service prod-peter -- bash -c "HOME=/data gbrain config get embedding_model" | grep -qE '^ollama:nomic-embed-text$' \
    && echo OK || (echo "FAIL: embedding_model is not pinned to ollama:nomic-embed-text"; exit 1)
  railway run --service prod-peter -- bash -c "HOME=/data gbrain config get embedding_dimensions" | grep -qE '^768$' \
    && echo OK || (echo "FAIL: embedding_dimensions is not 768"; exit 1)
  ```

- [ ] Production: the Postgres `content_chunks.embedding` column was actually altered to the new width (not just the config file) — confirms the `docs/embedding-migrations.md` column-alter recipe was run, not skipped.
  ```bash
  railway run --service prod-peter -- bash -c "HOME=/data gbrain doctor --json" | python3 -c "
  import json, sys
  d = json.load(sys.stdin)
  checks = {c.get('name') or c.get('id'): c for c in d.get('checks', [])}
  ewc = checks.get('embedding_width_consistency')
  assert ewc and ewc.get('status') in ('ok', 'pass', 'green'), f'FAIL: embedding_width_consistency not passing: {ewc}'
  print('OK —', ewc)
  "
  ```

- [ ] Production: the stale-embedding backlog is fully cleared after backfill — 0 stale chunks, not just 'reduced'.
  ```bash
  railway run --service prod-peter -- bash -c "HOME=/data gbrain embed --stale --dry-run" | grep -qE '^0 (stale|pending)|no stale' \
    && echo OK || (echo "FAIL: stale chunks remain after backfill — rerun gbrain embed --stale"; exit 1)
  ```

- [ ] Production: `gbrain doctor` overall reports clean on the embedding-related checks (`embedding_column_registry`, `embed_staleness`, `embedding_width_consistency` — exact check names per the issue and `docs/embedding-migrations.md`).
  ```bash
  railway run --service prod-peter -- bash -c "HOME=/data gbrain doctor --json" | python3 -c "
  import json, sys
  d = json.load(sys.stdin)
  checks = {c.get('name') or c.get('id'): c for c in d.get('checks', [])}
  bad = [k for k in ('embedding_column_registry', 'embed_staleness', 'embedding_width_consistency')
         if k in checks and checks[k].get('status') not in ('ok', 'pass', 'green')]
  assert not bad, f'FAIL: unhealthy checks: {bad}'
  print('OK — all embedding checks clean')
  "
  ```

- [ ] Production: retrieval spot-check — a known query term with content in the brain returns non-empty results via both `gbrain search` (keyword) and `gbrain query` (hybrid/vector).
  ```bash
  railway run --service prod-peter -- bash -c "HOME=/data gbrain search 'AAPL'" | grep -qv '^No pages found' \
    && echo "OK — search" || (echo "FAIL: gbrain search returned no results"; exit 1)
  railway run --service prod-peter -- bash -c "HOME=/data gbrain query 'AAPL'" | grep -qv '^No pages found' \
    && echo "OK — query" || (echo "FAIL: gbrain query returned no results post-migration"; exit 1)
  ```

- [ ] `npm test` passes with no new failures (in case any test fixtures reference the old embedding config/dimensions).
  ```bash
  npm test 2>&1 | tail -20
  ```

## Constraints

- Do not modify gbrain's own source code (`src/core/ai/recipes/ollama.ts` / `llama-server.ts` already exist and are usable as-is per the issue) — this is infra + config only, same constraint as `requirements/connect-postgres-to-gbrain.md`.
- Do not change the Railway deployment lifecycle or `prod-peter`'s own `railway.toml` build/deploy config — the new embedding-model service is an additional, separate Railway service, not a change to how `prod-peter` itself builds or deploys.
- Do not wipe or re-import brain pages as part of the migration — only the `content_chunks.embedding` column is cleared and re-embedded, per the documented Postgres column-alter recipe (drop HNSW index → `UPDATE ... SET embedding = NULL` → `ALTER COLUMN TYPE` → recreate index → re-embed). Page content/metadata must be untouched.
- Do not use ZeroEntropy, OpenAI, Voyage, or any other paid/hosted embedding API as the resulting provider — the entire point of this issue is $0 marginal cost. `Ollama` is the default choice per the issue unless implementation surfaces a concrete reason to prefer `llama-server` (e.g. wanting a specific GGUF model Ollama's catalog doesn't carry).
- Do not expose the new Ollama/llama-server Railway service publicly — it must only be reachable over the private network from within the `radiant-liberation` project.
- Do not break the existing `DATABASE_URL`/Postgres wiring in `lib/server/startup.js` (`ensureGbrainDatabaseConfig`) — this issue changes the embedding provider, not the database engine.

## When You Need Human Feedback

- **`lib/server/startup.js`'s fresh-install path doesn't pin an embedding model.** `ensureGbrainDatabaseConfig()` writes `{ engine: 'postgres', database_url: DATABASE_URL }` on first boot and then runs `gbrain apply-migrations --yes` — it never sets `embedding_model`/`embedding_dimensions`, and per gbrain's own docs, Ollama/llama-server are *not* picked up by env-key auto-detection (they have no API key to detect). That gap is arguably the root cause of this issue's origin (a fresh/updated install landed on a provider — ZeroEntropy — with an unset key, and nothing failed loudly). Should this task also update `startup.js` so a brand-new environment explicitly pins `ollama:nomic-embed-text` at 768 dims on first init, so this class of bug can't recur on the next fresh deploy? The issue's own Acceptance Criteria only covers the existing `prod-peter` brain (dimension migration + backfill), not this fresh-install code path — flagging since it seems closely related but is technically out of the stated scope. Suggested resolution: yes, extend `startup.js`'s fresh-config branch to pass an explicit embedding model/dimensions default, but confirm before implementation since it changes first-boot behavior for *every* future deployment, not just `prod-peter`.
- **Local dev Ollama service footprint.** Adding a persistent `ollama` service to `docker-compose.yml` means `npm run dev` now needs to pull and run an embedding model (even `nomic-embed-text` is a real download + RAM footprint) for every contributor, including those not touching gbrain/embeddings at all. Should the local `ollama` service be a hard dependency of `openclaw` (matching the existing `postgres` `depends_on: condition: service_healthy` pattern), or best-effort/optional so it doesn't slow down or break `npm run dev` for unrelated work? Suggested resolution: optional — don't gate `openclaw`'s startup health on `ollama` being up locally, since local embedding correctness isn't this issue's actual target (production is).
- **Exact Railway service name for `prod-peter` was not independently confirmed.** The Railway MCP tools available in this research session could list the `radiant-liberation` project (`list_projects`) but returned `Unauthorized` on `list_services`/`whoami`, so the live service name/current env vars on `prod-peter` could not be directly inspected — the verification commands above assume the service is literally named `prod-peter` per the issue text and matching usage in `requirements/issue-50-x-list-ingest-skill.md`. Confirm this against `railway service list --project radiant-liberation` (with working auth) before relying on the scripts above.
- **`gbrain doctor --json` check-name/status shape was not directly observed against a Postgres-backed brain with real stale/mismatched embeddings.** The local dev instance's `gbrain doctor` schema (check names, `status` value spelling — `ok`/`pass`/`green`/etc.) was not verified end-to-end against a brain actually in the broken state this issue describes; the check names (`embedding_column_registry`, `embed_staleness`, `embedding_width_consistency`) are taken from the issue text and official `docs/embedding-migrations.md`, but the exact JSON field names/status strings should be confirmed with `HOME=/data gbrain doctor --json | jq .` against `prod-peter` directly before finalizing the verification scripts, and the scripts above adjusted if the real shape differs.
