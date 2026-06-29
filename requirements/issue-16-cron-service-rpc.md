# fix(cron): update cron-service.js to read from gateway RPC instead of jobs.json — Requirements

## Goals

After deploying openclaw 2026.6.10, the AlphaClaw cron UI shows all configured jobs and
their statuses without error. Specifically:

- `GET /api/cron/jobs` returns the full list of cron jobs even when `cron/jobs.json` no
  longer exists (renamed to `jobs.json.migrated` by openclaw's migration preflight).
- `GET /api/cron/status` reports correct totals (job count, enabled flag, next wake time).
- `GET /api/cron/jobs/:id/runs` returns the run history for a given job.
- `GET /api/cron/jobs/:id/trends` and related analytics endpoints return correct data.
- Editing a job's prompt via the UI (`updateJobPrompt`) continues to send the correct CLI
  flag (`--message` for agentTurn jobs, `--system-event` for systemEvent jobs).
- No direct reads of `cron/jobs.json` or `cron/runs/*.jsonl` remain in
  `lib/server/cron-service.js` at runtime.

## Verifications

> All behaviours below must be verified by scripts, not by AI agent judgement.
> Never allow a graceful skip when external API credentials are present —
> if the API rejects the request the test must fail, not pass silently.

### Unit tests (fast, no container needed)

**`listJobs` / `getStatus`**

- [ ] `listJobs()` calls `clawCmd("cron list --json", { quiet: true })` and returns
  `{ jobs: [...] }` parsed from the RPC response `.jobs` array.
  Assertion: `expect(clawCmd).toHaveBeenCalledWith("cron list --json", expect.objectContaining({ quiet: true }))`.

- [ ] `getStatus()` calls `clawCmd("cron status --json", { quiet: true })` and returns an
  object with `{ enabled, jobs, nextWakeAtMs }` sourced from the RPC response.
  Assertion: `expect(clawCmd).toHaveBeenCalledWith("cron status --json", expect.objectContaining({ quiet: true }))`.

**`updateJobPrompt` / `resolvePromptEditFlag`**

- [ ] `updateJobPrompt` for an `agentTurn` job calls
  `openclaw cron show '<id>' --json` (or equivalent) to resolve payload kind, then calls
  `cron edit '<id>' --message '<text>'`.
  Assertion: `clawCmd` called first with `"cron show 'job-a' --json"`, then with
  `"cron edit 'job-a' --message 'hello world'"`.

- [ ] `updateJobPrompt` for a `systemEvent` job resolves payload kind via gateway and then
  calls `cron edit '<id>' --system-event '<text>'`.
  Assertion: `clawCmd` called with `"cron edit 'job-main' --system-event 'new prompt'"`.

**`getJobRuns` / run log reads**

- [ ] `getJobRuns({ jobId, limit, offset, status, sortDir })` calls
  `clawCmd("cron runs --id '<id>'", { quiet: true })` and returns filtered/sorted entries
  matching the requested `status`, `sortDir`, `limit`, and `offset`.
  Assertion: `expect(clawCmd).toHaveBeenCalledWith("cron runs --id 'job-a'", ...)`.

- [ ] `getRunByTs({ jobId, ts })` returns the run entry matching the given timestamp from
  data fetched via `cron runs --id '<id>'`.

- [ ] `readJobDurationStats({ jobId, sinceMs })` computes `avgDurationMs` from run entries
  fetched via `cron runs --id '<id>'`.

- [ ] `getJobRunTrends({ jobId, range })` returns time-bucketed trend points computed from
  run entries fetched via `cron runs --id '<id>'`.

- [ ] `getBulkJobRuns` and `getBulkJobUsage` return non-empty data for jobs that have runs,
  using the updated `getJobRuns` / `readJobDurationStats` implementations.

**Static analysis**

- [ ] `grep -n "readCronStore\|readJsonFile\|kCronStoreFile\|jobs\.json\|runs/" lib/server/cron-service.js`
  returns zero matches in function bodies reachable from `createCronService`'s returned
  object. Dead helpers that are fully removed are acceptable.

- [ ] `clawCmd` is never called with a file path containing `jobs.json` or `runs/`.

### Integration (Docker Compose local stack)

- [ ] Trigger migration: run any openclaw CLI command inside the container. Then assert
  `cron/jobs.json` has been archived:
  `docker exec <container> ls ~/.openclaw/cron/jobs.json.migrated` exits 0 and
  `docker exec <container> ls ~/.openclaw/cron/jobs.json` exits non-zero.

- [ ] `curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/cron/jobs | jq '.ok, (.jobs | length > 0)'`
  outputs `true` on both lines (jobs array is non-empty after migration).

- [ ] `curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/cron/status | jq '.ok, (.status.jobs > 0)'`
  outputs `true` on both lines.

- [ ] `curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/cron/jobs/<id>/runs | jq '.ok'`
  outputs `true` for a job that has at least one run recorded.

- [ ] Editing a job prompt via the UI sends the request without error; the gateway confirms
  the update (no "unknown cron job id" error in the response).

### RPC output shapes (for implementation reference)

**`openclaw cron list --json`** (from `cron.list` RPC, `--json` flag required):

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

**`openclaw cron status --json`** (from `cron.status` RPC, `--json` flag required):

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

Note: `jobs` is a **count** (not an array). There is no `enabledJobs` field — see Constraints.

**`openclaw cron show '<id>' --json`** (from `cron.get` RPC, `--json` flag required):

```json
{
  "id": "job-id",
  "name": "Job name",
  "enabled": true,
  "payload": { "kind": "agentTurn", "message": "..." },
  "schedule": { "kind": "cron", "expr": "0 8 * * *" },
  "state": {},
  "delivery": {}
}
```

Used by `resolvePromptEditFlag` to look up `payload.kind` instead of reading `jobs.json`.

**`openclaw cron runs --id '<id>'`** (always outputs JSON — no `--json` flag):

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
      "usage": {
        "input_tokens": 1000,
        "output_tokens": 500
      }
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 50,
  "hasMore": false,
  "nextOffset": null
}
```

Note: this command accepts `--limit <n>` (default 50) and `--run-id <runId>`. Status,
delivery, query, and sort filtering are not CLI-exposed — apply them in JS after fetching.
For `getJobRunTrends` and duration stats, fetch a sufficiently large page (e.g. `--limit 200`)
and compute locally using the existing bucketing and aggregation logic.

## Constraints

- `lib/server/routes/cron.js` must not change — it calls `cronService.*` through the same
  interface.
- Write operations (`runJobNow`, `setJobEnabled`, `updateJobRouting`) already use `clawCmd`
  and are unchanged except for `updateJobPrompt` (which needs its synchronous
  `resolvePromptEditFlag` call replaced with an async gateway RPC — the function is already
  `async` so this is a local refactor only).
- `resolvePromptEditFlag` is **in scope**: it reads `jobs.json` synchronously and breaks
  all prompt edits after migration. Replace its `readCronStore` call with an async
  `clawCmd("cron show '<id>' --json", { quiet: true })` call and parse `payload.kind` from
  the result.
- All JSONL-reading functions are **in scope**: openclaw 2026.6.10 confirmed — run logs moved
  to SQLite (`appendCronRunLog` and `readCronRunLogEntriesPage` both call
  `openOpenClawStateDatabase()`; the JSONL files are no longer written or read by the
  gateway). The following functions all read dead JSONL paths and must be updated:
  `getJobRuns`, `getJobRunTrends`, `readJobDurationStats`, `getBulkJobRuns`,
  `getBulkJobUsage` (duration stats portion), `getRunByTs`.
- `getStatus()` drops the `enabledJobs` field from its return value. The `cron status --json`
  RPC returns only a total `jobs` count; `enabledJobs` is not consumed by any frontend
  component (`grep -rn "enabledJobs" lib/public/` returns no matches) and is safe to remove.
- `readCronStore`, `readJsonFile`, and `kCronStoreFile` become dead code after this change
  and must be removed entirely.
- `tests/server/routes-cron.test.js` must pass without modification (it mocks `cronService`
  at the service boundary).
- No changes to `lib/server/commands.js` or any route module.

## When You Need Human Feedback

(none)
