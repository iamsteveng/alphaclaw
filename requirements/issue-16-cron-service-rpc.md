# fix(cron): update cron-service.js to read from gateway RPC instead of jobs.json — Requirements

## Goals

After deploying openclaw 2026.6.10, the AlphaClaw cron UI shows all configured jobs and
their statuses without error. Specifically:

- `GET /api/cron/jobs` returns the full list of cron jobs even when `cron/jobs.json` no
  longer exists (renamed to `jobs.json.migrated` by openclaw's migration preflight).
- `GET /api/cron/status` reports correct totals (job count, enabled flag, next wake time).
- `GET /api/cron/jobs/:id/runs` returns the run history for a given job.
- Editing a job's prompt via the UI (`updateJobPrompt`) continues to send the correct CLI
  flag (`--message` for agentTurn jobs, `--system-event` for systemEvent jobs).
- No direct reads of `cron/jobs.json` remain in `lib/server/cron-service.js` at runtime.

Observable behaviour only: the jobs table in the UI is populated, the status badge shows the
correct count, and prompt edits are accepted by the gateway without error.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

### Unit tests (fast, no container needed)

- [ ] `listJobs()` calls `clawCmd("cron list --json", { quiet: true })` and returns
  `{ jobs: [...] }` parsed from the RPC response `.jobs` array.
  Assertion: `expect(clawCmd).toHaveBeenCalledWith("cron list --json", expect.objectContaining({ quiet: true }))`.

- [ ] `getStatus()` calls `clawCmd("cron status --json", { quiet: true })` and returns an
  object with `{ enabled, jobs, nextWakeAtMs }` sourced from the RPC response.
  Assertion: `expect(clawCmd).toHaveBeenCalledWith("cron status --json", expect.objectContaining({ quiet: true }))`.

- [ ] `updateJobPrompt` for an `agentTurn` job still calls
  `cron edit '<id>' --message '<text>'` (unchanged).
  Assertion: existing test in `tests/server/cron-service.test.js` continues to pass.

- [ ] `updateJobPrompt` for a `systemEvent` job still calls
  `cron edit '<id>' --system-event '<text>'`.
  Assertion: existing test in `tests/server/cron-service.test.js` continues to pass.

- [ ] `clawCmd` is never called with a path containing `jobs.json` in any code path
  exercised by the unit tests.

### Static analysis

- [ ] `grep -n "readCronStore\|readJsonFile\|kCronStoreFile\|jobs\.json" lib/server/cron-service.js`
  returns zero matches in function bodies that are reachable at runtime (i.e. functions
  referenced from `createCronService`'s returned object). Dead helpers that are removed
  entirely are acceptable.

### Integration (Docker Compose local stack)

- [ ] Trigger migration: `docker exec <container> openclaw cron list` (any openclaw CLI
  invocation). Then assert `cron/jobs.json` has been renamed:
  `docker exec <container> ls ~/.openclaw/cron/jobs.json.migrated` exits 0 and
  `docker exec <container> ls ~/.openclaw/cron/jobs.json` exits non-zero.

- [ ] `curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/cron/jobs | jq '.ok, (.jobs | length > 0)'`
  outputs `true` on both lines (jobs array is non-empty after migration).

- [ ] `curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/cron/status | jq '.ok, (.status.jobs > 0)'`
  outputs `true` on both lines.

- [ ] `curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/cron/jobs/<id>/runs | jq '.ok'`
  outputs `true` for a job that has at least one run recorded.

### RPC output shapes (for implementation reference)

`openclaw cron list --json` response (from `cron.list` RPC):

```json
{
  "jobs": [
    {
      "id": "job-id",
      "name": "Job name",
      "enabled": true,
      "state": { "nextRunAtMs": 1234567890, "lastRunStatus": "ok" },
      "payload": { "kind": "agentTurn", "message": "..." },
      "schedule": { "kind": "cron", "expr": "0 8 * * *" },
      "delivery": {}
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 200,
  "hasMore": false,
  "nextOffset": null,
  "deliveryPreviews": {}
}
```

`openclaw cron status --json` response (from `cron.status` RPC):

```json
{
  "enabled": true,
  "storePath": "<path>",
  "storage": "sqlite",
  "sqlitePath": "<sqlite-path>",
  "jobs": 3,
  "nextWakeAtMs": 1234567890
}
```

Note: `jobs` in the status response is a **count** (not an array). There is no `enabledJobs`
field from this RPC — see Human Feedback item 3 if that field is needed.

`openclaw cron runs --id '<id>'` (no `--json` flag needed — always outputs JSON):

```json
{
  "entries": [
    {
      "ts": 1234567890,
      "jobId": "job-id",
      "action": "finished",
      "status": "ok",
      "sessionKey": "...",
      "durationMs": 5000,
      "model": "...",
      "usage": {}
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50,
  "hasMore": false,
  "nextOffset": null
}
```

## Constraints

- `lib/server/routes/cron.js` must not change — it calls `cronService.listJobs()`,
  `cronService.getStatus()`, and `cronService.getJobRuns()` through the same interface.
- Write operations (`runJobNow`, `setJobEnabled`, `updateJobRouting`) already use `clawCmd`
  and are unchanged.
- `getBulkJobRuns`, `getBulkJobUsage`, `getJobRunTrends`, `getRunByTs`, `getJobUsage`,
  and `readJobDurationStats` are out of scope unless Human Feedback item 2 confirms JSONL
  run logs no longer work — do not change them unless explicitly confirmed broken.
- `tests/server/routes-cron.test.js` must pass without modification (it mocks `cronService`
  at the service boundary — implementation changes inside `cron-service.js` are invisible
  to it).
- Do not change `lib/server/commands.js` (`clawCmd`) or any route module.

## When You Need Human Feedback

**1. `resolvePromptEditFlag` reads `jobs.json` synchronously.**

Observation: `resolvePromptEditFlag` (called inside `updateJobPrompt`) uses `readCronStore`
to find a job's `payload.kind`. After migration, `jobs.json` is gone, so this will throw
"unknown cron job id" for any job — breaking prompt edits.

Suggested resolution: make `resolvePromptEditFlag` async and replace the `readCronStore`
call with `clawCmd("cron show '<id>' --json", { quiet: true })`, then parse `.payload.kind`
from the response. This requires `updateJobPrompt` to `await` it (it is already `async`).

Confirm whether this function is in scope for this issue or tracked separately.
Tag @iamsteveng.

**2. JSONL run log status in openclaw 2026.6.10.**

Observation: The issue notes `getJobRuns` "may also be affected if run logs moved to
SQLite." From openclaw 2026.6.10 source, `appendCronRunLog` still writes to
`cron/runs/<id>.jsonl`, so files likely still exist. However the `cron.runs` RPC reads from
`context.cronStorePath` (the SQLite path), which may mean run history from before the
migration is in JSONL and new runs go to SQLite — or JSONL is still the sole storage.

Suggested resolution: before implementing `getJobRuns` changes, check the container after
one post-migration run:
```bash
docker exec <container> ls -la ~/.openclaw/cron/runs/
docker exec <container> openclaw cron runs --id '<id>'
```
If JSONL files are populated and `cron runs` returns the same entries, JSONL reads still
work and `getJobRuns` can remain unchanged. If JSONL is empty but `cron runs` returns data,
switch `getJobRuns` to `clawCmd("cron runs --id '<id>'", { quiet: true })`.

Tag @iamsteveng.

**3. `enabledJobs` field in `getStatus()` response.**

Observation: The current `getStatus()` returns `{ enabled, storePath, jobs, enabledJobs,
nextWakeAtMs }`. The `cron status --json` RPC response has no `enabledJobs` field (only
a total `jobs` count). Frontend search of `lib/public/` shows no component reads
`enabledJobs`, but the field is in the public API response shape.

Suggested resolution: drop `enabledJobs` from the `getStatus()` return value — it is not
consumed by the frontend. Confirm no external callers depend on it before removing.

Tag @iamsteveng.
