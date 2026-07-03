# Feature: alphaclaw init and track changes with the same github repo — Requirements

## Goals

When `GITHUB_TOKEN` and `GITHUB_WORKSPACE_REPO` are present as platform
environment variables (e.g. injected by Railway or Docker), the onboarding
flow automatically handles all **git-related steps** using those values —
without requiring the user to enter GitHub credentials in the Setup UI form.

Model authentication and channel authentication remain UI-only and are
**out of scope** for this feature.

Observable behaviours:

1. **Git steps auto-complete from env vars.** When the user submits the
   onboarding form (with model + channel credentials), if `GITHUB_TOKEN` and
   `GITHUB_WORKSPACE_REPO` are already present in the `.env` file (promoted
   from platform env by the existing `kVarsToPromote` step in
   `bin/alphaclaw.js`), the backend uses those values to perform all git
   operations — the user does not need to supply GitHub credentials in the form.

2. **Import path when repo is non-empty.** If `GITHUB_WORKSPACE_REPO` points
   to a repo that contains an existing `openclaw.json`, the git setup clones
   and restores from it (same as the "Import existing setup" UI mode).

3. **Fresh-repo path when repo is empty or absent.** If `GITHUB_WORKSPACE_REPO`
   points to an empty or non-existent repo, a new git repo is initialised and
   pushed (same as the "New setup" UI mode).

4. **UI falls back to explicit entry when env vars are absent.** If `GITHUB_TOKEN`
   or `GITHUB_WORKSPACE_REPO` are not present in `.env`, the onboarding form
   still collects them — existing behaviour unchanged.

5. **Hourly git sync cron is installed.** Regardless of whether the GitHub
   values came from env vars or the form, the hourly sync cron is installed
   as part of onboarding.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

### Git steps auto-complete from env vars

- [ ] When `GITHUB_TOKEN` and `GITHUB_WORKSPACE_REPO` are present in `.env`
  before onboarding, submitting `POST /api/onboard` with a valid model key and
  channel token but **without** `GITHUB_TOKEN` or `GITHUB_WORKSPACE_REPO` in
  the `vars` array returns `{ ok: true }` and completes onboarding:
  ```bash
  # Seed .env with GitHub vars
  echo "GITHUB_TOKEN=$GITHUB_TOKEN" >> "$ALPHACLAW_ROOT_DIR/.env"
  echo "GITHUB_WORKSPACE_REPO=$GITHUB_WORKSPACE_REPO" >> "$ALPHACLAW_ROOT_DIR/.env"
  # Submit onboarding without GitHub vars in body
  curl -sf -X POST http://localhost:3000/api/onboard \
    -H "Content-Type: application/json" \
    -d '{"vars":[{"key":"ANTHROPIC_API_KEY","value":"..."},{"key":"TELEGRAM_BOT_TOKEN","value":"..."}],"modelKey":"anthropic/claude-sonnet-4-6"}' \
    | grep -q '"ok":true'
  ```

- [ ] After onboarding completes, `$ALPHACLAW_ROOT_DIR/.openclaw/.git` exists:
  ```bash
  [ -d "$ALPHACLAW_ROOT_DIR/.openclaw/.git" ]
  ```

- [ ] `git -C $ALPHACLAW_ROOT_DIR/.openclaw remote get-url origin` returns
  `https://github.com/<GITHUB_WORKSPACE_REPO>.git`.

- [ ] The hourly git sync cron file is installed:
  ```bash
  [ -f /etc/cron.d/openclaw-hourly-sync ]
  grep -q 'hourly-git-sync' /etc/cron.d/openclaw-hourly-sync
  ```

- [ ] `$ALPHACLAW_ROOT_DIR/onboarded.json` is written and contains
  `"onboarded": true`.

### Import path (non-empty backup repo)

- [ ] When `GITHUB_WORKSPACE_REPO` points to a repo that already contains
  `openclaw.json`, onboarding completes in import mode: the restored
  `$ALPHACLAW_ROOT_DIR/.openclaw/openclaw.json` contains the same root keys
  as the source backup:
  ```bash
  diff <(jq -S 'keys' "$ALPHACLAW_ROOT_DIR/.openclaw/openclaw.json") \
       <(jq -S 'keys' backup_openclaw.json)
  # exits 0
  ```

### Fresh-repo path (empty or non-existent repo)

- [ ] When `GITHUB_WORKSPACE_REPO` points to an empty or non-existent repo,
  onboarding completes in new-setup mode: `onboarded.json` is written,
  `openclaw.json` is created under `.openclaw/`, and the remote repo is
  created/pushed:
  ```bash
  grep -q '"onboarded": true' "$ALPHACLAW_ROOT_DIR/onboarded.json"
  [ -f "$ALPHACLAW_ROOT_DIR/.openclaw/openclaw.json" ]
  git -C "$ALPHACLAW_ROOT_DIR/.openclaw" ls-remote --exit-code origin main
  ```

### Fallback when env vars are absent

- [ ] When `GITHUB_TOKEN` and `GITHUB_WORKSPACE_REPO` are absent from `.env`
  **and** absent from the submitted `vars` array, `POST /api/onboard` returns
  a 400 error with `"GitHub token and workspace repo are required"` — the
  existing validation error is preserved:
  ```bash
  curl -sf -X POST http://localhost:3000/api/onboard \
    -H "Content-Type: application/json" \
    -d '{"vars":[{"key":"ANTHROPIC_API_KEY","value":"..."},{"key":"TELEGRAM_BOT_TOKEN","value":"..."}],"modelKey":"anthropic/claude-sonnet-4-6"}' \
    | grep -q 'GitHub token and workspace repo are required'
  ```

### Env var promotion preserved

- [ ] `GITHUB_TOKEN` and `GITHUB_WORKSPACE_REPO` set as platform env vars are
  present in `.env` before the server starts (existing `kVarsToPromote`
  behaviour — no change required, just confirmed by test):
  ```bash
  GITHUB_TOKEN=test_token GITHUB_WORKSPACE_REPO=owner/repo alphaclaw start &
  sleep 3 && kill %1
  grep -E '^GITHUB_TOKEN=test_token' "$ALPHACLAW_ROOT_DIR/.env"
  grep -E '^GITHUB_WORKSPACE_REPO=owner/repo' "$ALPHACLAW_ROOT_DIR/.env"
  ```

## Constraints

- Model authentication and channel authentication are **not** automated from
  env vars — they remain UI-only; this feature must not add env-var handling
  for AI keys, Telegram tokens, Discord tokens, or any other channel/model
  credential.
- `validateOnboardingInput` in `lib/server/onboarding/validation.js` must read
  the current `.env` file values for `GITHUB_TOKEN` and `GITHUB_WORKSPACE_REPO`
  when they are absent from the submitted `vars` array, so the `hasGithub`
  check can be satisfied by pre-promoted env vars.
- No changes to the model selection or channel setup steps in `completeOnboarding`.
- The existing behaviour when GitHub vars are supplied in the form must be
  unchanged — form values take precedence over env file values.
- No new startup-time auto-onboarding: `onboarded.json` is still only written
  when the user completes the Setup UI (model + channel step). The server must
  not write `onboarded.json` on startup without UI interaction.
- Existing onboarding unit tests (`tests/server/routes-onboarding.test.js`,
  `tests/server/onboarding-validation.test.js`) must continue to pass.

## When You Need Human Feedback

1. **Precedence when both sources are present.**
   If `GITHUB_TOKEN` is in `.env` (promoted from platform) and the user also
   supplies a different value in the form `vars` array, which wins?
   Form value is the natural answer (same pattern as the rest of onboarding),
   but needs explicit confirmation to avoid surprise behaviour for users who
   rotate tokens.

   @iamsteveng: confirm form value takes precedence over `.env` promoted value,
   or should the env-var value always win?
