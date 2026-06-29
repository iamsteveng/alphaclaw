# Feature: Enable More OpenAI Models — Requirements

## Goals

When an operator has authenticated via the OpenAI Codex OAuth flow, they can select and use any of the OpenAI models that are accessible to their Codex subscription as the primary agent model.

### What the official OpenClaw docs say (sourced from docs.openclaw.ai)

The official OpenClaw provider docs state:

> "OpenClaw uses one provider id, `openai`, for both auth shapes."

The Codex harness docs add:

> "Use `openai/gpt-*` for OpenAI agent turns through Codex. Do not use legacy Codex GPT refs in config."
> "Run `openclaw doctor --fix` to repair legacy refs and stale session route pins."

This means the `openai-codex/` model key prefix used in AlphaClaw's current bootstrap catalog is a **legacy/deprecated concept** at the OpenClaw layer. All models — whether accessed via Codex OAuth or via API key — use the `openai/` prefix at the OpenClaw level.

### Confirmed Codex-subscription-accessible models (from docs.openclaw.ai/providers/openai)

| Model key | Codex subscription | API key |
|---|---|---|
| `openai/gpt-5.5` | ✓ default | ✓ |
| `openai/gpt-5.4-mini` | ✓ | ✓ |
| `openai/gpt-5.3-codex-spark` | ✓ required | ✗ blocked |
| `openai/chat-latest` | ✗ N/A | ✓ only |

> Source: [OpenAI · OpenClaw](https://docs.openclaw.ai/providers/openai), [Codex harness · OpenClaw](https://docs.openclaw.ai/plugins/codex-harness)

### What needs to change in AlphaClaw

AlphaClaw's `openai-codex` provider exists as an auth-routing abstraction — UI shows "OpenAI Codex" with OAuth login, while `openai` shows the API key input. This distinction is valid at the AlphaClaw layer even if OpenClaw itself normalises everything to `openai/`.

The issue is that the bootstrap catalog for `openai-codex` is incomplete relative to the `openai` catalog. Recent models (`gpt-5.5`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`) that are confirmed Codex-accessible are either absent from or not prominently featured in the `openai-codex` catalog section.

The following `openai-codex/` entries are confirmed to correspond to Codex-accessible models and should be present:

- `openai-codex/gpt-5.5` — GPT-5.5 (already present)
- `openai-codex/gpt-5.4` — GPT-5.4 (already present)
- `openai-codex/gpt-5.4-mini` — GPT-5.4 Mini (already present)
- `openai-codex/gpt-5.3-codex` — Codex GPT-5.3 (already present)
- `openai-codex/gpt-5.3-codex-spark` — GPT-5.3 Codex Spark (**missing from catalog**)

`gpt-5.3-codex-spark` is the only model the official docs explicitly mark as Codex-subscription–only (API key access is blocked by OpenClaw). It must be added.

For any additional models beyond these five, the docs do not publish a complete subscription tier list — those require human confirmation (see "When You Need Human Feedback").

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

- [ ] `lib/server/model-catalog-bootstrap.json` contains an entry with key `openai-codex/gpt-5.3-codex-spark` and provider `openai-codex`.
  ```bash
  python3 -c "
  import json
  data = json.load(open('lib/server/model-catalog-bootstrap.json'))
  keys = {m['key'] for m in data.get('models', [])}
  assert 'openai-codex/gpt-5.3-codex-spark' in keys, 'Missing openai-codex/gpt-5.3-codex-spark'
  m = next(x for x in data['models'] if x['key'] == 'openai-codex/gpt-5.3-codex-spark')
  assert m.get('provider') == 'openai-codex', f'Wrong provider: {m.get(\"provider\")}'
  assert m.get('label', '').strip(), 'Empty label'
  print('OK')
  "
  ```

- [ ] `GET /api/models/catalog` response includes `openai-codex/gpt-5.3-codex-spark` with provider `openai-codex`.
  ```bash
  curl -s -b /tmp/ac.txt http://localhost:3001/api/models/catalog \
    | python3 -c "
  import json, sys
  models = json.load(sys.stdin).get('models', [])
  match = next((m for m in models if m['key'] == 'openai-codex/gpt-5.3-codex-spark'), None)
  assert match, 'openai-codex/gpt-5.3-codex-spark not in catalog'
  assert match['provider'] == 'openai-codex', f'Wrong provider: {match[\"provider\"]}'
  print('OK')
  "
  ```

- [ ] All five confirmed Codex models are present in the bootstrap catalog with correct provider and non-empty label.
  ```bash
  python3 -c "
  import json
  data = json.load(open('lib/server/model-catalog-bootstrap.json'))
  by_key = {m['key']: m for m in data.get('models', [])}
  required = [
    'openai-codex/gpt-5.5',
    'openai-codex/gpt-5.4',
    'openai-codex/gpt-5.4-mini',
    'openai-codex/gpt-5.3-codex',
    'openai-codex/gpt-5.3-codex-spark',
  ]
  errors = []
  for k in required:
    m = by_key.get(k)
    if not m: errors.append(f'missing: {k}')
    elif m.get('provider') != 'openai-codex': errors.append(f'wrong provider: {k}')
    elif not m.get('label', '').strip(): errors.append(f'empty label: {k}')
  assert not errors, errors
  print('OK — all 5 confirmed Codex models present')
  "
  ```

- [ ] Pre-existing `openai-codex` catalog entries are not removed (regression check).
  ```bash
  python3 -c "
  import json
  data = json.load(open('lib/server/model-catalog-bootstrap.json'))
  keys = {m['key'] for m in data.get('models', [])}
  existing = ['openai-codex/gpt-5.5', 'openai-codex/gpt-5.3-codex', 'openai-codex/gpt-5.4',
              'openai-codex/gpt-5.4-mini', 'openai-codex/gpt-5.1', 'openai-codex/gpt-5.2']
  missing = [k for k in existing if k not in keys]
  assert not missing, f'Regression — removed: {missing}'
  print('OK')
  "
  ```

- [ ] `npm test` passes with no new failures.
  ```bash
  npm test 2>&1 | tail -20
  ```

## Constraints

- This is additive only — do not remove any existing `openai-codex/*` entries from the bootstrap catalog.
- Do not change the Codex OAuth flow (`lib/server/routes/codex.js`) — authentication is out of scope.
- Do not change the `openai` provider model list.
- Do not migrate `openai-codex/` keys to `openai/` keys — that is a separate architectural decision (see human feedback below).
- Do not alter `kProviderAuthFields`, `kProviderLabels`, or `kProviderOrder` in `lib/public/js/lib/model-config.js`.

## When You Need Human Feedback

- **Should `openai-codex/gpt-5.3-codex-spark` be the only new addition, or are there more models?** The official OpenClaw docs confirm `gpt-5.3-codex-spark` as Codex-subscription–only. The complete list of Codex-accessible models is not published. The bootstrap catalog already has `gpt-5.1` through `gpt-5.4-mini` under `openai-codex`. **Suggested resolution:** @iamsteveng — run `openclaw models list --provider openai` on a Codex-authenticated instance to get the live catalog; any model returned there that is absent from the `openai-codex` section of the bootstrap catalog is a gap. If the output is available, we can add all of them in one pass.

- **Should AlphaClaw migrate from the `openai-codex/` prefix to `openai/` to align with official OpenClaw conventions?** The official docs explicitly deprecate `openai-codex/` model refs and `openclaw doctor --fix` repairs them. AlphaClaw currently uses `openai-codex/` as a UI-layer auth-routing signal (OAuth vs API key), but this creates a growing maintenance burden as every new model must be duplicated across both provider entries. A future PR could collapse `openai-codex/` into `openai/` and use auth-profile presence to decide which credential to use. **This is out of scope for issue #18 but @iamsteveng should decide before further catalog growth.** Tag as follow-on issue if yes.

- **Is `openai/chat-latest` (API-key only per docs) worth adding to the `openai` provider catalog?** The docs call it a "moving alias for the latest Instant model." Suggested resolution: add it to the `openai` catalog as-is; it is already a pattern in that provider section.
