# Feature: alphaclaw init and track changes with the same github repo — Requirements

## Goals

When a user deploys a fresh AlphaClaw instance with `GITHUB_TOKEN` and
`GITHUB_WORKSPACE_REPO` pointing to a non-empty existing backup repo, **and**
all required credential env vars are present in the platform environment, the
server completes onboarding automatically on first boot — without any human
interaction with the Setup UI.

Observable behaviours:

1. **Auto-init on startup.** If `onboarded.json` is absent, required env vars
   are all present, and `GITHUB_WORKSPACE_REPO` resolves to a non-empty repo
   that contains an `openclaw.json`, the server runs the headless import
   sequence and writes `onboarded.json` before listening for requests.

2. **Import mirrors the UI flow.** The restored state (config, skills, cron
   jobs) is identical to what the "Import existing setup" UI path produces for
   the same source repo.

3. **Gateway starts without UI visit.** After auto-init, the OpenClaw gateway
   is started and a fresh Telegram/Discord/channel session can be initiated
   immediately.

4. **Idempotent re-deploys.** On all subsequent boots, the presence of
   `onboarded.json` causes the server to skip the auto-init path entirely and
   proceed directly to `runOnboardedBootSequence`.

5. **Graceful fallback.** If any required env var is missing, or the GitHub
   repo is inaccessible, the server falls back to "Awaiting onboarding via
   Setup UI" with a descriptive log line — no crash, no partial state written.

6. **Fresh-repo variant.** If `GITHUB_WORKSPACE_REPO` points to an empty or
   non-existent repo (and a model key env var is set), the server runs the
   headless fresh-onboarding path instead, creating a new repo and config.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

### Headless import path (primary case)

- [ ] When `GITHUB_TOKEN`, `GITHUB_WORKSPACE_REPO` (pointing to a non-empty
  backup repo), at least one AI key, and at least one channel token are set,
  and `onboarded.json` does not exist, starting the server writes
  `onboarded.json` within 120 s:
  ```bash
  timeout 120 alphaclaw start &
  until [ -f "$ALPHACLAW_ROOT_DIR/onboarded.json" ]; do sleep 2; done
  grep -q '"onboarded": true' "$ALPHACLAW_ROOT_DIR/onboarded.json"
  ```

- [ ] After auto-init, `$ALPHACLAW_ROOT_DIR/.openclaw/.git` exists and
  `git -C $ALPHACLAW_ROOT_DIR/.openclaw remote get-url origin` outputs
  `https://github.com/<GITHUB_WORKSPACE_REPO>.git`.

- [ ] After auto-init, `$ALPHACLAW_ROOT_DIR/.openclaw/openclaw.json` exists
  and contains the same root keys (`gateway`, `channels`, `plugins`) as the
  source backup repo's `openclaw.json`:
  ```bash
  diff <(jq -S 'keys' restored_openclaw.json) <(jq -S 'keys' backup_openclaw.json)
  # exits 0
  ```

- [ ] The hourly git sync cron is installed:
  ```bash
  [ -f /etc/cron.d/openclaw-hourly-sync ]
  grep -q 'hourly-git-sync' /etc/cron.d/openclaw-hourly-sync
  ```

- [ ] The OpenClaw gateway process is running after auto-init:
  ```bash
  curl -sf http://127.0.0.1:18789/health | grep -q '"status":"ok"'
  ```

- [ ] If `GITHUB_TOKEN` is absent, the server logs
  `[alphaclaw] Awaiting onboarding via Setup UI` and does **not** write
  `onboarded.json`:
  ```bash
  GITHUB_TOKEN= alphaclaw start &
  sleep 5
  [ ! -f "$ALPHACLAW_ROOT_DIR/onboarded.json" ]
  ```

- [ ] If `GITHUB_WORKSPACE_REPO` is absent, same behaviour as above.

- [ ] If the GitHub API rejects the token (401), the server logs a descriptive
  error referencing token verification failure and does **not** write
  `onboarded.json`.

- [ ] If the repo does not exist and `GITHUB_TOKEN` has no create-repo
  permission, the server logs a descriptive error and does **not** write
  `onboarded.json`.

### Idempotency

- [ ] On a second start with `onboarded.json` already present, the server does
  **not** call the auto-init path (verify by absence of `[auto-init]` log
  prefix in output).

- [ ] After a re-deploy that wipes `onboarded.json` but leaves `.openclaw/`
  intact, auto-init detects the existing `.git` dir and skips `git init`
  (verify log output includes `[auto-init] Skipped git init (existing repo)`
  or equivalent).

### Fresh-repo variant

- [ ] When `GITHUB_WORKSPACE_REPO` points to an empty or non-existent repo and
  a model key env var (`ALPHACLAW_INIT_MODEL`) is set, the server completes
  fresh onboarding: `onboarded.json` written, `openclaw.json` created, gateway
  started.

### Env var promotion

- [ ] After auto-init, `$ALPHACLAW_ROOT_DIR/.env` contains `GITHUB_TOKEN` and
  `GITHUB_WORKSPACE_REPO` with the values injected as platform env vars (not
  empty):
  ```bash
  grep -E '^GITHUB_TOKEN=.+' "$ALPHACLAW_ROOT_DIR/.env"
  grep -E '^GITHUB_WORKSPACE_REPO=.+' "$ALPHACLAW_ROOT_DIR/.env"
  ```

## Constraints

- The existing UI-based onboarding flow (`POST /api/onboard`) must remain
  unchanged — no existing onboarding tests may be broken.
- `validateOnboardingInput` in `lib/server/onboarding/validation.js` must still
  gate all headless attempts with the same rules as the UI path.
- `isOnboarded()` in `lib/server/gateway.js` must remain a single check on
  `onboarded.json` — do not add secondary markers.
- The headless auto-init must run **before** `server.listen()` completes (or
  immediately after, blocking `runOnboardedBootSequence`), not as a background
  task that races with incoming requests.
- `lib/server/init/server-lifecycle.js` (`startServerLifecycle`) is the correct
  insertion point — do not modify the bin entry point startup sequence for this.
- `kVarsToPromote` in `bin/alphaclaw.js` already promotes `GITHUB_TOKEN` and
  `GITHUB_WORKSPACE_REPO` to `.env` before the server starts; rely on this
  rather than re-reading platform env vars inside the headless path.
- Do not break the Railway / Docker container setup: auto-init must handle the
  case where `/etc/cron.d/` is writable (container) and gracefully skip cron
  installation when it is not.

## When You Need Human Feedback

1. **Model key for headless init.**
   `completeOnboarding` always calls `openclaw models set <modelKey>`. In the
   UI, the user picks a model from a list. For headless import, the primary
   model may be readable from the backup's `openclaw.json`
   (`models.primary` field — needs verification against actual openclaw config
   schema). For headless fresh setup, no model is pre-selected.
   
   Two options:
   - (a) Introduce `ALPHACLAW_INIT_MODEL` env var (e.g.
     `anthropic/claude-sonnet-4-6`). Required for fresh setup; optional for
     import (falls back to reading from backup config if present).
   - (b) For import mode only: skip `openclaw models set` if a model is already
     configured in the restored `openclaw.json`.
   
   **Suggest a resolution:** option (a) — a single explicit env var is easier
   to document and test than conditional config-file introspection.
   
   @iamsteveng: which approach, and what should the env var be named?

2. **Scope: import-only or also fresh setup?**
   The issue text focuses on "restore from an existing github repo". The fresh-
   setup headless path (Goal 6) is a natural extension but may be out of scope.
   
   @iamsteveng: should fresh-repo headless onboarding be part of this PR, or
   deferred to a follow-up?

3. **Timing: block server.listen or run immediately after?**
   Auto-init runs `openclaw onboard` (up to 120 s) and `git clone`. If this
   blocks `server.listen`, Railway's health check may time out. If it runs
   after listen, the `/api/status` endpoint returns "not onboarded" briefly.
   
   @iamsteveng: is a brief "not onboarded" window acceptable, or must the
   health check only succeed after init is complete?
