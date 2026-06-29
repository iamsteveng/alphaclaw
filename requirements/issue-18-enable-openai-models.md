# Feature: Enable More OpenAI Models — Requirements

## Goals

When an operator has authenticated via the OpenAI Codex OAuth flow, they can select and use any of the OpenAI models that are accessible to their Codex subscription as the primary agent model — not just the small set currently hard-coded in the catalog.

Specifically, the following new models must appear as selectable options in the Models tab under the "OpenAI Codex" provider:

- `openai-codex/gpt-5` — GPT-5
- `openai-codex/gpt-5-mini` — GPT-5 Mini
- `openai-codex/gpt-5-nano` — GPT-5 Nano
- `openai-codex/gpt-5-pro` — GPT-5 Pro
- `openai-codex/gpt-5-codex` — GPT-5 Codex
- `openai-codex/gpt-5.1-codex` — GPT-5.1 Codex
- `openai-codex/gpt-5.2-pro` — GPT-5.2 Pro
- `openai-codex/gpt-5.3-chat-latest` — GPT-5.3 Chat (latest)
- `openai-codex/gpt-5.4-nano` — GPT-5.4 Nano
- `openai-codex/gpt-5.4-pro` — GPT-5.4 Pro
- `openai-codex/o3` — o3
- `openai-codex/o3-mini` — o3-mini
- `openai-codex/o4-mini` — o4-mini

All newly added models are selectable with no additional auth beyond the existing Codex OAuth connection. The auth UI, token refresh, and model-set API remain unchanged.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

- [ ] `GET /api/models/catalog` returns a list that includes `openai-codex/gpt-5`, `openai-codex/o3`, and `openai-codex/o4-mini` with `provider: "openai-codex"`.
  ```bash
  curl -s -b /tmp/ac.txt http://localhost:3001/api/models/catalog \
    | python3 -c "import json,sys; m=json.load(sys.stdin).get('models',[]); \
      keys={x['key'] for x in m}; \
      needed={'openai-codex/gpt-5','openai-codex/o3','openai-codex/o4-mini'}; \
      missing=needed-keys; assert not missing, f'Missing: {missing}'"
  ```

- [ ] `GET /api/models/catalog` returns every new model in the Goals list (13 models) under `provider: "openai-codex"`.
  ```bash
  curl -s -b /tmp/ac.txt http://localhost:3001/api/models/catalog \
    | python3 -c "
  import json,sys
  needed=[
    'openai-codex/gpt-5','openai-codex/gpt-5-mini','openai-codex/gpt-5-nano',
    'openai-codex/gpt-5-pro','openai-codex/gpt-5-codex','openai-codex/gpt-5.1-codex',
    'openai-codex/gpt-5.2-pro','openai-codex/gpt-5.3-chat-latest',
    'openai-codex/gpt-5.4-nano','openai-codex/gpt-5.4-pro',
    'openai-codex/o3','openai-codex/o3-mini','openai-codex/o4-mini',
  ]
  m=json.load(sys.stdin).get('models',[])
  keys={x['key'] for x in m}
  missing=[k for k in needed if k not in keys]
  assert not missing, f'Missing from catalog: {missing}'
  print('OK — all 13 new models present')
  "
  ```

- [ ] All new `openai-codex/*` entries in `lib/server/model-catalog-bootstrap.json` have a non-empty `label` field.
  ```bash
  python3 -c "
  import json
  data=json.load(open('lib/server/model-catalog-bootstrap.json'))
  new_keys=[
    'openai-codex/gpt-5','openai-codex/gpt-5-mini','openai-codex/gpt-5-nano',
    'openai-codex/gpt-5-pro','openai-codex/gpt-5-codex','openai-codex/gpt-5.1-codex',
    'openai-codex/gpt-5.2-pro','openai-codex/gpt-5.3-chat-latest',
    'openai-codex/gpt-5.4-nano','openai-codex/gpt-5.4-pro',
    'openai-codex/o3','openai-codex/o3-mini','openai-codex/o4-mini',
  ]
  by_key={m['key']:m for m in data.get('models',[])}
  bad=[k for k in new_keys if not by_key.get(k,{}).get('label','').strip()]
  assert not bad, f'Missing or empty label: {bad}'
  print('OK — all labels present')
  "
  ```

- [ ] `POST /api/models/set` with `{"modelKey": "openai-codex/o4-mini"}` returns `{ok: true}` when a valid Codex OAuth session exists, and the subsequent `GET /api/models/status` response includes `modelKey: "openai-codex/o4-mini"`.
  (Requires live Codex-authenticated instance — skip only if no Codex OAuth token is available.)

- [ ] Existing `openai-codex` models that were already in the catalog before this change (`openai-codex/gpt-5.5`, `openai-codex/gpt-5.3-codex`, `openai-codex/gpt-5.4`, etc.) are still present in `GET /api/models/catalog` after the change.
  ```bash
  curl -s -b /tmp/ac.txt http://localhost:3001/api/models/catalog \
    | python3 -c "
  import json,sys
  existing=['openai-codex/gpt-5.5','openai-codex/gpt-5.3-codex',
            'openai-codex/gpt-5.4','openai-codex/gpt-5.4-mini',
            'openai-codex/gpt-5.1','openai-codex/gpt-5.2']
  keys={m['key'] for m in json.load(sys.stdin).get('models',[])}
  missing=[k for k in existing if k not in keys]
  assert not missing, f'Regression — removed: {missing}'
  print('OK')
  "
  ```

- [ ] `npm test` passes with no new failures after the changes.
  ```bash
  npm test 2>&1 | tail -20
  ```

## Constraints

- Do not remove any currently listed `openai-codex/*` models from the catalog — this is additive only.
- Do not change the Codex OAuth flow (`lib/server/routes/codex.js`) — authentication is out of scope.
- Do not change the `openai` provider model list — only `openai-codex` provider entries are in scope.
- Do not alter `kProviderAuthFields`, `kProviderLabels`, or `kProviderOrder` in `lib/public/js/lib/model-config.js` — provider-level config is unchanged.
- `lib/server/constants.js` `kMinimalFallbackOnboardingModels` may be updated to add one or two representative new models (e.g. `openai-codex/o4-mini`) but removing existing entries is not allowed.

## When You Need Human Feedback

- **Which models are accessible via Codex subscription vs. OpenAI API key only?** The issue says users can authenticate new models "with OpenAI Codex subscription," but the OpenAI docs do not publish a definitive machine-readable list of which models are Codex-subscription–gated vs. API-key–only. The 13 models listed in Goals mirror the `openai` provider catalog entries that are absent from the current `openai-codex` catalog — but OpenAI may restrict some of these (e.g. `o3-pro`, `o1-pro`) to API-key accounts only. **Suggested resolution:** @iamsteveng to confirm which of the 13 new models are actually accessible via Codex OAuth, or confirm "add all and let the gateway return a 403 for inaccessible ones" is acceptable.

- **Should reasoning/o-series models (`o3`, `o3-mini`, `o4-mini`) require any UI label changes to communicate their reasoning behaviour to users?** The existing UI shows no special badge for reasoning models. Suggested resolution: keep the label as-is for now (behaviour-only change), flag as future work.
