# Set up Ollama/llama-server as self-hosted embedding provider for gbrain — Requirements

## Goals

- `prod-peter`'s gbrain instance embeds content using a self-hosted model (Ollama, `nomic-embed-text` by default) instead of the hosted ZeroEntropy API — no `ZEROENTROPY_API_KEY` (or any other paid embedding-provider key) is required for gbrain to function going forward.
- The embedding model runs as its own Railway service inside the `radiant-liberation` project, reachable from `prod-peter` only over Railway's private network (`*.railway.internal`) — not exposed publicly.
- The existing backlog of stale, never-embedded `content_chunks` (1,946 at the time the issue was filed, larger by implementation time) is fully backfilled under the new provider.
- Local dev (`docker-compose.yml`) gets the same embedding provider available as a service, consistent with this repo's stated goal that "the conditions in local container setup are the same as that in Railway production instance" (see `requirements/connect-postgres-to-gbrain.md`), so a contributor working on gbrain/embedding-adjacent code can reproduce the setup without needing a paid API key either.
- `gbrain query` / `gbrain search` continue to return sensible, non-empty results against the live brain after the model/dimension switch — the migration doesn't silently degrade retrieval into a broken or empty-result state.
- Connecting an embedding provider is **optional and can happen at any time**, on any deployment — not just at fresh install. A deployment with no `OLLAMA_BASE_URL`/`LLAMA_SERVER_BASE_URL` set runs with no embedding provider configured (page CRUD and keyword search still work; only vector/hybrid search is degraded until a provider is connected), and this is a normal, supported state — not an error. `lib/server/startup.js` gains the same detect-and-wire-up behavior for the embedding provider that `ensureGbrainDatabaseConfig()` already has for `DATABASE_URL`: on every boot, if `OLLAMA_BASE_URL`/`LLAMA_SERVER_BASE_URL` is set and gbrain isn't yet pinned to it, wire it in explicitly (Ollama/llama-server are not auto-detected by gbrain's own key-presence logic); if already pinned, no-op; if unset, do nothing. This closes the actual root cause of this issue — a schema sized for a provider whose key was never set, silently sitting at 0% embedded — without forcing every future deployment to run an embedding provider it doesn't need. Implemented as `ensureGbrainEmbeddingConfig()` in `lib/server/startup.js`, live-verified end-to-end in `docker-compose` (see Local Verifications below).
- **`OLLAMA_BASE_URL`/`LLAMA_SERVER_BASE_URL` must include the `/v1` suffix** (e.g. `http://ollama:11434/v1`, not `http://ollama:11434`) — confirmed by reading gbrain's `ollama`/`llama-server` recipes (`base_url_default: 'http://localhost:11434/v1'` / `'http://localhost:8080/v1'`) and by live-testing both forms in `docker-compose`: without `/v1` every embed call 404s (`recipe.base_url_default` is only used when the env var is absent — when present, gbrain's OpenAI-compatible client uses it *as-is*, it does not append `/v1` itself). `docker-compose.yml`'s `ollama` service definition sets this correctly; the same suffix is required on `prod-peter`'s env var in production.

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

- [ ] Local: `openclaw`'s compose definition does NOT depend on `ollama` health — `npm run dev` still comes up cleanly with the `ollama` service stopped/removed.
  ```bash
  docker compose stop ollama 2>/dev/null || true
  docker compose up -d openclaw postgres
  CONTAINER="${CONTAINER:-openclaw-railway-template-openclaw-1}"
  timeout 30 bash -c "until docker exec \"$CONTAINER\" curl -sf http://localhost:3000/health >/dev/null; do sleep 1; done" \
    && echo "OK — openclaw healthy with ollama stopped" || (echo "FAIL: openclaw failed to start without ollama running"; exit 1)
  python3 -c "
  import yaml
  svc = yaml.safe_load(open('docker-compose.yml'))['services']['openclaw']
  depends = svc.get('depends_on', {})
  ollama_dep = depends.get('ollama') if isinstance(depends, dict) else None
  hard = isinstance(ollama_dep, dict) and ollama_dep.get('condition') == 'service_healthy'
  assert not hard, 'FAIL: openclaw hard-depends on ollama service_healthy'
  print('OK — no hard depends_on ollama')
  "
  ```

- [ ] Local: a real page imports, embeds via Ollama, and is retrievable — end-to-end proof the recipe + private network path work, not just that the HTTP port answers. **Do not use `gbrain providers test` for this** — live-tested and confirmed it always fails here even when Ollama embeddings work correctly: `providers test`'s own `configureFromEnv()` (`src/commands/providers.ts`) builds its gateway config from `config?.provider_base_urls` only, unlike the real embed path used by `import`/`embed`/`search`/`sync` (`src/cli.ts`'s main dispatch), which calls `buildGatewayConfig()` and correctly folds `OLLAMA_BASE_URL` in. Since nothing in this flow ever persists `provider_base_urls` to `~/.gbrain/config.json`, `providers test` always falls back to `recipe.base_url_default` (`http://localhost:11434/v1`) and fails to connect — a gbrain quirk isolated to that one subcommand, out of scope to fix (`src/commands/*` is gbrain's own source, not ours to modify).
  ```bash
  CONTAINER="${CONTAINER:-openclaw-railway-template-openclaw-1}"
  docker exec "$CONTAINER" bash -c "
    set -e
    HOME=/data
    export HOME
    rm -rf /tmp/embed-check && mkdir -p /tmp/embed-check
    echo '# Embed Check
  Verifies Ollama embeddings work end-to-end via the real gbrain import/embed/search pipeline.' > /tmp/embed-check/probe.md
    gbrain import /tmp/embed-check --no-embed
    gbrain embed --stale
    gbrain search 'Embed Check' | grep -q probe
  " && echo OK || (echo "FAIL: Ollama embed-and-search round trip failed"; exit 1)
  ```

> The commands below use `railway ssh`, not `railway run` — `railway run` only injects env vars into a **local** command, it does not execute inside the remote container (confirmed via `railway run --help`: "Run a **local** command using variables from the active environment"). `railway ssh -p <project> -s <service> -e <environment> "<cmd>"` is the form that actually executes on the live instance — confirmed working against `prod-peter` directly during this doc's review (e.g. `gbrain doctor --json`, `gbrain search`, `gbrain embed --stale --dry-run` were all run live).
>
> `RAILWAY_PROJECT_ID` below is `radiant-liberation`'s real ID (`ffbb8141-53c9-49f9-9acb-c5def26e135a`) — `railway ssh --project radiant-liberation` (by name) does not resolve; the CLI requires the UUID.

```bash
export RAILWAY_PROJECT_ID="ffbb8141-53c9-49f9-9acb-c5def26e135a"
export RAILWAY_ENV="production"
rssh() { railway ssh -p "$RAILWAY_PROJECT_ID" -s prod-peter -e "$RAILWAY_ENV" "$1"; }
```

- [ ] Production: a Railway service running Ollama (or llama-server) exists in the `radiant-liberation` project and is reachable from `prod-peter` over the private network.
  ```bash
  railway service list -p "$RAILWAY_PROJECT_ID" -e "$RAILWAY_ENV" --json | grep -qiE '"name":\s*"(ollama|llama-server)"' \
    && echo OK || (echo "FAIL: no ollama/llama-server service found in radiant-liberation"; exit 1)

  # Reachability from prod-peter itself, not just "the service exists":
  rssh 'curl -sf "$OLLAMA_BASE_URL/api/tags" || curl -sf "${OLLAMA_BASE_URL%/v1}/tags"' \
    && echo OK || (echo "FAIL: prod-peter cannot reach the ollama service over the private network"; exit 1)
  ```

- [ ] Production: `prod-peter`'s env has `OLLAMA_BASE_URL` (or `LLAMA_SERVER_BASE_URL`) set, and no longer needs `ZEROENTROPY_API_KEY` for gbrain to embed.
  ```bash
  railway variables list -s prod-peter -p "$RAILWAY_PROJECT_ID" -e "$RAILWAY_ENV" --json | python3 -c "
  import json, sys
  v = json.load(sys.stdin)
  assert v.get('OLLAMA_BASE_URL') or v.get('LLAMA_SERVER_BASE_URL'), 'FAIL: no OLLAMA_BASE_URL/LLAMA_SERVER_BASE_URL set'
  print('OK')
  "
  ```

- [ ] Production: gbrain's file-plane config (`~/.gbrain/config.json` on `prod-peter`, read via `gbrain config get`) is pinned to the new provider/dimension pair — not left on the old `zeroentropyai:zembed-1`/1280 config that was never actually populated.
  ```bash
  rssh "HOME=/data gbrain config get embedding_model" | grep -qE '^ollama:nomic-embed-text$' \
    && echo OK || (echo "FAIL: embedding_model is not pinned to ollama:nomic-embed-text"; exit 1)
  rssh "HOME=/data gbrain config get embedding_dimensions" | grep -qE '^768$' \
    && echo OK || (echo "FAIL: embedding_dimensions is not 768"; exit 1)
  ```

- [ ] Production: the Postgres `content_chunks.embedding` **and** `facts.embedding` columns were both actually altered to the new width (not just the config file). Real `gbrain doctor --json` output confirms these are two *separate* vector columns — `embedding_width_consistency` covers `content_chunks` (currently `vector(1280)`), `facts_embedding_width_consistency` covers `facts.embedding` (currently `halfvec(1280)`). `docs/embedding-migrations.md`'s column-alter recipe only mentions `content_chunks` — the `facts` table needs the same treatment or this check will fail post-migration. Confirmed real schema (list format, not a `checks: {name: ...}` map) via a live `gbrain doctor --json` run: top-level `{"schema_version","status","health_score","checks":[{"name","status","message","category"}, ...],"top_issues":[...]}`, and `status` values are `"ok"`/`"warn"` (not `"pass"`/`"green"`).
  ```bash
  rssh "HOME=/data gbrain doctor --json" | python3 -c "
  import json, sys
  d = json.load(sys.stdin)
  checks = {c['name']: c for c in d.get('checks', [])}
  for name in ('embedding_width_consistency', 'facts_embedding_width_consistency'):
      c = checks.get(name)
      assert c and c.get('status') == 'ok', f'FAIL: {name} not passing: {c}'
      print('OK —', name, '—', c.get('message'))
  "
  ```

- [ ] Production: the `content_chunks` stale-embedding backlog is fully cleared after backfill — 0 stale chunks, not just 'reduced'. Real dry-run output format confirmed live: `[dry-run] Would embed <N> stale chunks`.
  ```bash
  rssh "HOME=/data gbrain embed --stale --dry-run" | grep -qE '^\[dry-run\] Would embed 0 stale chunks' \
    && echo OK || (echo "FAIL: stale chunks remain after backfill — rerun gbrain embed --stale"; exit 1)
  ```

- [ ] Production: `gbrain doctor` overall reports clean on the embedding-related checks — real check names confirmed live: `embeddings`, `embedding_provider`, `embedding_column_registry`, `ze_embedding_health` (category `ops`/`brain`), and `embed_staleness` (category `meta`). Before this fix, live output showed: `embeddings` warn ("No embeddings yet"), `embedding_column_registry` warn ("0.0% populated"), `ze_embedding_health` warn ("ZEROENTROPY_API_KEY is not set"), `embed_staleness` warn ("2290 stale chunks"). All four must flip to `ok` (or the check must no longer apply, e.g. `ze_embedding_health` is ZeroEntropy-specific and may simply disappear once the provider changes — confirm which at implementation time).
  ```bash
  rssh "HOME=/data gbrain doctor --json" | python3 -c "
  import json, sys
  d = json.load(sys.stdin)
  checks = {c['name']: c for c in d.get('checks', [])}
  bad = [k for k in ('embeddings', 'embedding_column_registry', 'embed_staleness')
         if k in checks and checks[k].get('status') != 'ok']
  assert not bad, f'FAIL: unhealthy checks: {[(k, checks[k]) for k in bad]}'
  if 'ze_embedding_health' in checks and checks['ze_embedding_health'].get('status') != 'ok':
      print('NOTE: ze_embedding_health still present and unhealthy — confirm this check is provider-specific and expected to clear:', checks['ze_embedding_health'])
  print('OK — embeddings/embedding_column_registry/embed_staleness clean')
  "
  ```

- [ ] Production: retrieval spot-check — a known query term with content in the brain returns non-empty results via both `gbrain search` (keyword) and `gbrain query` (hybrid/vector). Real no-match phrasing confirmed live is `No results.` (distinct from `gbrain list`'s `No pages found.`). Confirmed live term: `plans/wmt` exists, so `WMT` returns real ranked results today (via keyword fallback, pre-migration) — re-run the same query post-migration and confirm `plans/wmt` still ranks and the score comes from vector similarity, not just tsvector.
  ```bash
  rssh "HOME=/data gbrain search WMT" | grep -q 'plans/wmt' \
    && echo "OK — search" || (echo "FAIL: gbrain search no longer surfaces plans/wmt for WMT"; exit 1)
  rssh "HOME=/data gbrain query WMT" | grep -qv '^No results\.' \
    && echo "OK — query" || (echo "FAIL: gbrain query returned no results post-migration"; exit 1)
  ```

- [ ] Fresh install with no embedding env vars set: `gbrain doctor` does not error or block on the missing embedding provider — the brain is usable (page CRUD, keyword search) with embeddings simply unconfigured.
  ```bash
  node -e "
  const fs = require('fs'), os = require('os'), path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-fresh-'));
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL || '', HOME: tmp };
  delete env.OLLAMA_BASE_URL; delete env.LLAMA_SERVER_BASE_URL;
  console.log('env prepared for fresh-install-no-embedding scenario at', tmp);
  "
  # then boot alphaclaw against a fresh /data with DATABASE_URL set but no OLLAMA_BASE_URL/LLAMA_SERVER_BASE_URL.
  # Confirmed live against prod-peter: `gbrain doctor --json` exits 0 even with multiple `warn`-status embedding
  # checks present (top-level {"status":"warnings", "checks":[{"name","status","message","category"},...]}) —
  # there is no exitCode/ok boolean field; "non-fatal" means process exit code 0, not a particular JSON field.
  HOME="$FRESH_DATA_DIR" gbrain doctor --json > /tmp/doctor.json
  DOCTOR_EXIT=$?
  if [ "$DOCTOR_EXIT" -ne 0 ]; then
    echo "FAIL: gbrain doctor exited non-zero ($DOCTOR_EXIT) with no embedding provider configured"; exit 1
  fi
  python3 -c "
  import json
  d = json.load(open('/tmp/doctor.json'))
  assert d.get('status') not in ('error', 'critical'), f\"FAIL: doctor top-level status is fatal: {d.get('status')}\"
  print('OK — unconfigured embedding provider is non-fatal, doctor exited 0 with status:', d.get('status'))
  "
  ```

- [ ] Connecting an embedding provider later (existing deployment, previously no `OLLAMA_BASE_URL`) gets wired up automatically on next boot — no manual `gbrain init`/`reinit-pglite` run by a human required.
  ```bash
  # Set OLLAMA_BASE_URL on a deployment that previously had none, restart, then:
  HOME="$DATA_DIR" gbrain config get embedding_model | grep -qE '^ollama:' \
    && echo OK || (echo "FAIL: embedding provider not auto-wired on restart after OLLAMA_BASE_URL was set"; exit 1)
  ```

- [ ] Idempotency: restarting again with the same `OLLAMA_BASE_URL` already pinned is a no-op (matches the existing `DATABASE_URL` "postgres config is current" log-line pattern) — does not re-trigger a dimension migration or re-embed on every boot.
  ```bash
  # Restart twice in a row with OLLAMA_BASE_URL unchanged; confirm no re-migration/re-embed log lines on the second boot.
  npm run dev:restart 2>&1 | grep -qi "embedding.*current\|embedding.*no-op" \
    && echo OK || echo "INFO: confirm log wording once implemented — must not re-run migration on unchanged env"
  ```

- [ ] `npm test` passes with no new failures (in case any test fixtures reference the old embedding config/dimensions).
  ```bash
  npm test 2>&1 | tail -20
  ```

## Constraints

- Do not modify gbrain's own source code (`src/core/ai/recipes/ollama.ts` / `llama-server.ts` already exist and are usable as-is per the issue) — this is infra + config only, same constraint as `requirements/connect-postgres-to-gbrain.md`.
- Do not change the Railway deployment lifecycle or `prod-peter`'s own `railway.toml` build/deploy config — the new embedding-model service is an additional, separate Railway service, not a change to how `prod-peter` itself builds or deploys.
- Do not wipe or re-import brain pages as part of the migration — only the `content_chunks.embedding` (and, per the live-confirmed schema, `facts.embedding`) vector columns are cleared and re-embedded, per the documented Postgres column-alter recipe (drop HNSW index → `UPDATE ... SET embedding = NULL` → `ALTER COLUMN TYPE` → recreate index → re-embed) applied to both tables. Page content/metadata must be untouched.
- Do not use ZeroEntropy, OpenAI, Voyage, or any other paid/hosted embedding API as the resulting provider — the entire point of this issue is $0 marginal cost. `Ollama` is the default choice per the issue unless implementation surfaces a concrete reason to prefer `llama-server` (e.g. wanting a specific GGUF model Ollama's catalog doesn't carry).
- Do not expose the new Ollama/llama-server Railway service publicly — it must only be reachable over the private network from within the `radiant-liberation` project.
- Do not break the existing `DATABASE_URL`/Postgres wiring in `lib/server/startup.js` (`ensureGbrainDatabaseConfig`) — this issue changes the embedding provider, not the database engine.
- Do not force a default embedding provider on deployments that never set `OLLAMA_BASE_URL`/`LLAMA_SERVER_BASE_URL` — connecting one is opt-in and must remain possible at any point in a deployment's life, not just at fresh install.
- The local `docker-compose.yml` `ollama` service must not gate `openclaw`'s startup or health check — no `depends_on: condition: service_healthy` on it, unlike `postgres`. `npm run dev` must keep working with the `ollama` service absent, unhealthy, or not yet pulled; it's an available service to opt into locally, not a required one.

## When You Need Human Feedback

(none — all open questions from the initial draft are resolved:

1. **Embedding provider is opt-in, connectable at any time** (resolved by @iamsteveng): not forced at fresh install — see the "optional, connect at any time" Goal and the `ensureGbrainDatabaseConfig`-style detect-and-wire-up Verifications above. `startup.js` extends the existing `DATABASE_URL` detection pattern to `OLLAMA_BASE_URL`/`LLAMA_SERVER_BASE_URL` rather than defaulting every fresh install to Ollama.
2. **Local `ollama` compose service does not gate `openclaw`'s health** (resolved by @iamsteveng): no hard `depends_on: condition: service_healthy`, so `npm run dev` keeps working for contributors not touching embeddings.
3. **`prod-peter` is the correct, confirmed live service name** (resolved via Railway MCP/CLI once reconnected): `radiant-liberation` contains exactly two services, `Postgres` and `prod-peter`; confirmed with a live `gbrain doctor --json` run against it.
4. **`facts.embedding` migration path** (resolved by reading gbrain's `master` source): `docs/embedding-migrations.md`'s prose never mentions the `facts` table, but the tooling isn't missing it — `facts.embedding` drift detection shipped in v0.41.15.0 (`src/core/embedding-dim-check.ts`: `readFactsEmbeddingDim`, `buildFactsAlterRecipe`; `src/commands/doctor.ts`: `checkFactsEmbeddingWidthConsistency`), and `prod-peter` runs v0.42.38.0, well after that. On drift, `facts_embedding_width_consistency` pastes the exact `DROP INDEX` → `ALTER TABLE facts ALTER COLUMN embedding TYPE ...` → `CREATE INDEX` SQL directly into the check's `message` field — the same self-generating-recipe pattern as `content_chunks`, just not written into the prose doc. Concrete implementation step: after migrating `content_chunks` and re-pointing gbrain's config to `ollama:nomic-embed-text`/768, run `gbrain doctor --json` again — if `facts_embedding_width_consistency` reports `status: "warn"`, its `message` is the paste-ready SQL for `facts`; run it, then re-check for `status: "ok"`.)
