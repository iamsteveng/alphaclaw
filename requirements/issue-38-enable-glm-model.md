# Feature: Enable GLM Model — Requirements

## Goals

- From the AlphaClaw setup UI's Models tab, an operator with a Zhipu AI **BigModel** API key (obtained from `https://open.bigmodel.cn`, the platform referenced by the issue's docs link) can authorize it as a model provider credential.
- After authorizing, the operator can browse and select any GLM model currently published by the BigModel chat completions API (full list below) as the primary model for an agent, or as an additional configured model.
- Once selected, the agent's chat requests are actually routed to BigModel's endpoint using the stored key — not silently sent to a different regional endpoint the key doesn't work against.
- The provider is labeled distinctly enough in the UI (e.g. "GLM (BigModel)") that a user with a BigModel-issued key can find and configure it without confusing it with the existing global "Z.AI" entry.

### What already exists vs. what's missing

AlphaClaw already has a `zai` provider (`lib/server/constants.js`, `lib/server/auth-profiles.js`, `lib/public/js/lib/model-config.js`) labeled **"Z.AI"**, backed by a single `ZAI_API_KEY` env var, and `lib/server/model-catalog-bootstrap.json` already lists 13 `zai/glm-*` models (`glm-4.5` through `glm-5.1`, plus `glm-5v-turbo`, `glm-4.5v`), last refreshed 2026-04-26.

Two concrete gaps against the issue:

1. **No base URL control.** Nothing in AlphaClaw's server code writes or reads a provider's base URL into `openclaw.json` (`grep -rn "baseUrl" lib/server/` turns up nothing related to model providers). The `zai` provider's requests go wherever OpenClaw's `zai` plugin defaults to (its global `api.z.ai` endpoint), not `open.bigmodel.cn`. A key issued from the BigModel console is a distinct regional credential and is not guaranteed to authenticate against the global endpoint. There is currently no way, through AlphaClaw's UI or API, to point a GLM provider at BigModel's endpoint.
2. **Stale/incomplete catalog.** Per the live BigModel API reference (fetched and verbatim-quoted from `docs.bigmodel.cn` during this research — the page states *"GLM-5.2 是最新的旗舰模型系列"*, i.e. GLM-5.2 is the current flagship), the full published model list is:

   - **Text:** `glm-5.2`, `glm-5.1`, `glm-5-turbo`, `glm-5`, `glm-4.7`, `glm-4.7-flash`, `glm-4.7-flashx`, `glm-4.6`, `glm-4.5-air`, `glm-4.5-airx`, `glm-4.5-flash`, `glm-4-flash-250414`, `glm-4-flashx-250414`
   - **Vision:** `glm-5v-turbo`, `glm-4.6v`, `glm-4.6v-flash`, `glm-4.6v-flashx`, `glm-4v-flash`, `glm-4.1v-thinking-flashx`, `glm-4.1v-thinking-flash`, `autoglm-phone`
   - **Audio:** `glm-4-voice`
   - **Character/role-play:** `charglm-4`, `emohaa`

   Source: https://docs.bigmodel.cn/api-reference/模型-api/对话补全 (Model API → Chat Completions)

   Against the current bootstrap catalog, **missing**: `glm-5.2` (the flagship model), `glm-4.5-airx`, `glm-4-flash-250414`, `glm-4-flashx-250414`, `glm-4.6v-flash`, `glm-4.6v-flashx`, `glm-4v-flash`, `glm-4.1v-thinking-flashx`, `glm-4.1v-thinking-flash`, `autoglm-phone`, `glm-4-voice`, `charglm-4`, `emohaa`.

### Proposed shape (see "When You Need Human Feedback" for the open design question)

Add a new, distinct provider id **`glm`** (label "GLM (BigModel)"), backed by a new env var **`GLM_API_KEY`**, whose requests are pinned server-side to BigModel's endpoint:

- Endpoint: `POST https://open.bigmodel.cn/api/paas/v4/chat/completions`
- Auth: `Authorization: Bearer <GLM_API_KEY>`

This is additive alongside the existing `zai` provider (which keeps working for existing global Z.AI users) rather than overloading `zai` with a second endpoint.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

- [ ] All 24 documented GLM models are present in the bootstrap catalog under the `glm` provider, each with a non-empty label.
  ```bash
  python3 -c "
  import json
  data = json.load(open('lib/server/model-catalog-bootstrap.json'))
  keys = {m['key'] for m in data.get('models', [])}
  required = [
    'glm/glm-5.2','glm/glm-5.1','glm/glm-5-turbo','glm/glm-5',
    'glm/glm-4.7','glm/glm-4.7-flash','glm/glm-4.7-flashx',
    'glm/glm-4.6','glm/glm-4.5-air','glm/glm-4.5-airx','glm/glm-4.5-flash',
    'glm/glm-4-flash-250414','glm/glm-4-flashx-250414',
    'glm/glm-5v-turbo','glm/glm-4.6v','glm/glm-4.6v-flash','glm/glm-4.6v-flashx',
    'glm/glm-4v-flash','glm/glm-4.1v-thinking-flashx','glm/glm-4.1v-thinking-flash',
    'glm/autoglm-phone','glm/glm-4-voice','glm/charglm-4','glm/emohaa',
  ]
  missing = [k for k in required if k not in keys]
  assert not missing, f'Missing: {missing}'
  by_key = {m['key']: m for m in data['models']}
  errors = [k for k in required if by_key[k].get('provider') != 'glm' or not by_key[k].get('label','').strip()]
  assert not errors, f'Bad entries: {errors}'
  print(f'OK — all {len(required)} GLM models present with provider=glm and non-empty label')
  "
  ```

- [ ] Pre-existing `zai/glm-*` catalog entries are untouched (regression check — this feature is additive, not a migration).
  ```bash
  python3 -c "
  import json
  data = json.load(open('lib/server/model-catalog-bootstrap.json'))
  keys = {m['key'] for m in data.get('models', [])}
  existing = ['zai/glm-4.5','zai/glm-4.5-air','zai/glm-4.5-flash','zai/glm-4.5v',
              'zai/glm-4.6','zai/glm-4.6v','zai/glm-4.7','zai/glm-4.7-flash',
              'zai/glm-4.7-flashx','zai/glm-5','zai/glm-5-turbo','zai/glm-5.1','zai/glm-5v-turbo']
  missing = [k for k in existing if k not in keys]
  assert not missing, f'Regression — removed existing zai entries: {missing}'
  print('OK')
  "
  ```

- [ ] `kKnownVars` (`lib/server/constants.js`) has a `GLM_API_KEY` entry with `group: "ai"` and `"Models"` in its `features`.
  ```bash
  node -e "
  const { kKnownVars } = require('./lib/server/constants');
  const entry = kKnownVars.find((v) => v.key === 'GLM_API_KEY');
  if (!entry) { console.error('Missing GLM_API_KEY in kKnownVars'); process.exit(1); }
  if (entry.group !== 'ai') { console.error('Wrong group: ' + entry.group); process.exit(1); }
  if (!entry.features || !entry.features.includes('Models')) { console.error('Missing Models feature'); process.exit(1); }
  console.log('OK');
  "
  ```

- [ ] `auth-profiles.js` maps provider `glm` to env var `GLM_API_KEY`.
  ```bash
  node -e "
  const { getEnvVarForApiKeyProvider, createAuthProfiles } = require('./lib/server/auth-profiles');
  const envVar = getEnvVarForApiKeyProvider('glm');
  if (envVar !== 'GLM_API_KEY') { console.error('Expected GLM_API_KEY, got: ' + envVar); process.exit(1); }
  console.log('OK');
  "
  ```

- [ ] Frontend `model-config.js` exposes auth field, label, and feature metadata for `glm`.
  ```bash
  node -e "
  import('./lib/public/js/lib/model-config.js').then(({ kProviderAuthFields, kProviderLabels, kProviderFeatures }) => {
    const fields = kProviderAuthFields.glm;
    if (!fields || !fields.some((f) => f.key === 'GLM_API_KEY')) { console.error('Missing GLM_API_KEY auth field'); process.exit(1); }
    if (!kProviderLabels.glm) { console.error('Missing kProviderLabels.glm'); process.exit(1); }
    if (!kProviderFeatures.glm || !kProviderFeatures.glm.includes('Agent Model')) { console.error('Missing Agent Model feature'); process.exit(1); }
    console.log('OK');
  }).catch((e) => { console.error(e); process.exit(1); });
  "
  ```

- [ ] Saving a `glm` credential via `PUT /api/models/config` results in `openclaw.json` routing `glm` requests to BigModel's endpoint (`https://open.bigmodel.cn/api/paas/v4`), verified end-to-end through the running app, not by inspecting AlphaClaw's own code.
  ```bash
  curl -s -b /tmp/ac.txt -X PUT http://localhost:3001/api/models/config \
    -H "Content-Type: application/json" \
    -d '{"profiles":[{"id":"glm:default","type":"api_key","provider":"glm","key":"test-key-not-real"}]}' \
    | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok') is True, d"
  curl -s -b /tmp/ac.txt http://localhost:3001/api/models/auth \
    | python3 -c "
  import json, sys
  d = json.load(sys.stdin)
  match = next((p for p in d.get('profiles', []) if p.get('provider') == 'glm'), None)
  assert match, 'glm profile not present after save'
  print('OK')
  "
  ```

- [ ] Live BigModel API call succeeds end-to-end when a real key is available (must fail loudly, not skip silently, if the key is present but rejected).
  ```bash
  if [ -n "$GLM_API_KEY" ]; then
    resp=$(curl -s -w "\n%{http_code}" https://open.bigmodel.cn/api/paas/v4/chat/completions \
      -H "Authorization: Bearer $GLM_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"model":"glm-4-flash-250414","messages":[{"role":"user","content":"hi"}]}')
    code=$(echo "$resp" | tail -1)
    body=$(echo "$resp" | sed '$d')
    if [ "$code" != "200" ]; then echo "FAIL: HTTP $code — $body"; exit 1; fi
    echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('choices'), 'no choices in response: ' + str(d)"
    echo "OK — live BigModel call succeeded"
  else
    echo "SKIP (no GLM_API_KEY present in this environment) — must run with a real key in CI/staging before merge to prod"
  fi
  ```

- [ ] `npm test` passes with no new failures.
  ```bash
  npm test 2>&1 | tail -20
  ```

## Constraints

- Additive only — do not remove or modify any existing `zai/*` catalog entries, `zai` auth field, or `ZAI_API_KEY` wiring. Existing global Z.AI users must be unaffected.
- Do not add a generic, user-editable "base URL" field to the Models UI/API for arbitrary providers — that is a larger architectural change out of scope for this issue. The BigModel endpoint should be pinned server-side for the `glm` provider specifically.
- Do not modify `node_modules/openclaw` (the vendored OpenClaw package) — all wiring must go through AlphaClaw's own config/env-var layer (`constants.js`, `auth-profiles.js`, `model-config.js`, `routes/models.js`).
- Do not change the shape or behavior of `/api/models/auth`, `/api/models/config`, `/api/models/set`, or `/api/models/status` for any other existing provider.
- Do not require re-onboarding — this must be addable by an already-onboarded operator purely through the post-onboarding Models tab / API, matching how DeepSeek and other non-onboarding-flagged providers are added today.

## When You Need Human Feedback

- **Should GLM/BigModel be a brand-new provider id (`glm`), or should the existing `zai` provider gain a regional/base-URL override instead?** OpenClaw's own `zai` plugin already documents CN-specific onboarding auth-choices (`zai-cn` / `zai-coding-cn`) that resolve to `open.bigmodel.cn`, but those choices are only wired into AlphaClaw's *initial onboarding* flow (`lib/server/onboarding/openclaw.js`), not the post-onboarding Models tab used by every other provider. This doc recommends a new dedicated `glm` provider (clean, no risk to existing Z.AI users, matches the issue's own wording of "GLM model" rather than "Z.AI"), but a generic base-URL-override mechanism on `zai` would also solve it and might be preferred if BigModel-CN vs. global-Z.AI regional splits show up for other providers later. **@iamsteveng** — please confirm which direction to build.
- **Exact env var / provider id naming.** This doc uses `GLM_API_KEY` / provider id `glm` / label "GLM (BigModel)" as a concrete, testable choice, since the issue and the referenced docs both call it "GLM". If a different name is preferred (e.g. to match an existing internal convention), the verification scripts above will need the literal strings swapped accordingly. **@iamsteveng** — confirm or override.
- **Should vision/audio/role-play models (`glm-4v-flash`, `glm-4-voice`, `charglm-4`, `emohaa`, etc.) be selectable as an agent's primary model in AlphaClaw at all?** AlphaClaw's model picker drives the coding agent's chat completions; audio and character/role-play models are unlikely to function as a general coding-agent backend. This doc includes them in the catalog for completeness ("make sure all the model options available," per the issue), but they may need to be filtered out of the *primary model* picker while still being valid for other purposes (e.g. `autoglm-phone` for a phone-automation flow, if AlphaClaw ever supports one). **@iamsteveng** — confirm whether to include them all in the primary-model picker unfiltered, or exclude the non-text models.
- **Model list will drift.** Zhipu ships new GLM versions frequently (5 new IDs appeared between the bootstrap catalog's 2026-04-26 snapshot and this doc). The verification above is a point-in-time snapshot sourced from `docs.bigmodel.cn` fetched during this research; implementation should re-check the live docs page (or `openclaw models list --all --json` against a BigModel-authenticated instance, if OpenClaw's `zai`/`glm` plugin exposes live catalog refresh) rather than assuming this list is still exhaustive by the time of implementation.
