# feat(cron): auto-populate Discord channels/DMs in cron delivery target dropdown — Requirements

## Background

The cron job settings UI already lets a job "announce" its result to a previously-seen
destination session (`lib/public/js/components/cron-tab/cron-job-settings-card.js:169-219`,
"Delivery" `<select>`). That list is sourced from `GET /api/agent/sessions`
(`lib/server/routes/system.js:739-746` → `listSendableAgentSessions()`,
`lib/server/routes/system.js:313-357`), which already calls
`clawCmd("sessions --json --all-agents")` — i.e. **all** sessions across all channels,
unfiltered, are already fetched from the gateway. Nothing needs to change to *retrieve*
Discord channel sessions; the gap is entirely in how those sessions are then filtered and
labeled for the destination dropdown:

1. `getSessionReplyTarget()` (`lib/server/routes/system.js:289-311`) only recognizes Telegram
   session-key patterns (`:telegram:direct:...`, `:telegram:group:...:topic:...`). For any
   Discord session — DM or guild channel alike — it falls through to
   `{ replyChannel: "", replyTo: "" }`.
2. `isDestinationSessionKey()` (`lib/public/js/lib/session-keys.js:13-19`) only matches keys
   containing `:direct:` or `:group:`. Discord session keys use these shapes (confirmed via
   `node_modules/openclaw/docs/channels/discord.md:311` and
   `node_modules/openclaw/dist/session-key-normalization-dz_8RO8l.js:10-20`):
   - DM: `agent:<agentId>:discord:direct:<userId>` — matches `:direct:`, so it currently
     *passes* the key-pattern filter, but still resolves to no destination because (1) above
     never sets `replyChannel`/`replyTo` for it.
   - Guild channel: `agent:<agentId>:discord:channel:<channelId>` — matches neither
     `:direct:` nor `:group:`, so it is excluded from the dropdown entirely today.

`kDestinationSessionFilter` (`session-keys.js:21-25`) combines both signals (OR), and
`getDestinationFromSession` (`session-keys.js:47-57`) requires a non-empty `replyChannel`
*and* `replyTo` to produce a usable `{ channel, to }` delivery target — so today, **no**
Discord destination (DM or channel) can actually be selected and saved as a working cron
delivery target, even though Discord DM keys pass the naive key-pattern check.

## Goals

After this change, the cron job "Delivery" dropdown auto-populates every Discord
destination — DM or server channel — that the agent has previously replied in, exactly the
way it already does for Telegram. Specifically:

- A Discord DM session (`...:discord:direct:<userId>`) resolves via `getSessionReplyTarget()`
  to `{ replyChannel: "discord", replyTo: "<userId>" }`.
- A Discord guild channel session (`...:discord:channel:<channelId>`) resolves via
  `getSessionReplyTarget()` to `{ replyChannel: "discord", replyTo: "<channelId>" }`.
- `isDestinationSessionKey()` also matches `:channel:` so Discord guild-channel sessions pass
  the frontend destination filter (needed as a fallback signal even though the server now
  populates `replyChannel`/`replyTo` for them; keeps the two signals consistent, matching
  how `:direct:`/`:group:` are both handled today).
- `getSessionDisplayLabel()` (`session-keys.js:94-122`) produces a distinguishable label for a
  Discord guild channel row (e.g. `Discord Channel <id>` or similar), instead of falling back
  to the raw session key. A Discord DM should keep using/extending the existing "Direct
  <target>" fallback path.
- Selecting a Discord destination and saving routing continues to send the existing wire
  shape unchanged: `PUT /api/cron/jobs/:id/routing` with
  `{ deliveryMode: "announce", deliveryChannel: "discord", deliveryTo: "<userId-or-channelId>" }`.
- No regression to existing Telegram (and any Slack) destination population, ordering
  (`sortSessionsByPriority`), or dedupe (`deliverySessionOptions` in
  `cron-job-settings-card.js:82-110`).

## Verifications

> All behaviors below must be verified by scripts, not by AI agent judgement.

### Unit tests (fast, no container needed)

**`getSessionReplyTarget` (server, `lib/server/routes/system.js`)**

- [ ] Given `agent:main:discord:direct:123456`, returns
      `{ replyChannel: "discord", replyTo: "123456" }`.
- [ ] Given `agent:main:discord:channel:987654`, returns
      `{ replyChannel: "discord", replyTo: "987654" }`.
- [ ] Existing Telegram assertions (`:telegram:direct:`, `:telegram:group:...:topic:...`)
      still pass unchanged — no regression to those branches.
- [ ] An unrecognized/other session key still returns `{ replyChannel: "", replyTo: "" }`.

**`listSendableAgentSessions` (server)**

- [ ] Mock `clawCmd` to return a payload containing a `discord:direct:` row and a
      `discord:channel:` row; assert both rows in the returned array have non-empty
      `replyChannel`/`replyTo` and `channel: "discord"`.

**`isDestinationSessionKey` / `kDestinationSessionFilter` (frontend,
`lib/public/js/lib/session-keys.js`)**

- [ ] `isDestinationSessionKey("agent:main:discord:channel:987654")` returns `true`.
- [ ] `isDestinationSessionKey("agent:main:discord:direct:123456")` still returns `true`
      (no regression).
- [ ] `kDestinationSessionFilter` includes a session row shaped
      `{ key: "agent:main:discord:channel:987654", replyChannel: "discord", replyTo: "987654" }`.

**`getDestinationFromSession` (frontend)**

- [ ] Given a Discord channel session row with `replyChannel`/`replyTo` populated, returns
      `{ channel: "discord", to: "987654", agentId: "main" }`.

**`getSessionDisplayLabel` / `getSessionKind` (frontend)**

- [ ] A Discord guild-channel session key produces a label distinct from the raw key (not
      just falling through to `return key || "Session"`).
- [ ] Existing labels for `main`, `topic`, `direct`, doctor-run kinds are unchanged
      (no regression — add channel-kind handling as an additional branch, don't restructure
      existing branches).

### Static analysis

- [ ] `grep -n ":telegram:direct:\|:telegram:group:" lib/server/routes/system.js` still shows
      the original Telegram regexes untouched (only a new Discord branch added alongside).
- [ ] `grep -n "sessionTarget\|deliveryMode\|deliveryChannel\|deliveryTo" lib/server/routes/cron.js`
      shows no changes to that route's payload contract.

### Integration (Docker Compose local stack)

- [ ] With the bot paired to a real (or test) Discord server and a DM: send one message to
      the bot in a guild text channel and one in a DM, so both sessions exist.
- [ ] `curl -s -b /tmp/alphaclaw-cookies.txt http://localhost:3001/api/agent/sessions | jq '.sessions[] | select(.channel=="discord")'`
      shows both rows with non-empty `replyChannel`/`replyTo`.
- [ ] In the cron job settings UI, the Delivery dropdown lists both the Discord DM and the
      Discord channel as distinct, readable options.
- [ ] Selecting the Discord channel option and saving sends
      `PUT /api/cron/jobs/:id/routing` with `deliveryChannel: "discord"` and
      `deliveryTo: "<channelId>"` (inspect via browser network tab or
      `docker exec <container> ... cron show '<id>' --json` after save).
- [ ] Manually trigger the job (`POST /api/cron/jobs/:id/run`) and confirm — best-effort
      visual check, not scriptable from this repo — that a message actually posts to the
      selected Discord channel. See Constraints below regarding the external delivery engine.

## Constraints

- `lib/server/routes/cron.js`'s `PUT /jobs/:id/routing` payload contract
  (`sessionTarget`/`wakeMode`/`deliveryMode`/`deliveryChannel`/`deliveryTo`) must not change.
- `lib/server/cron-service.js`'s `updateJobRouting` (lines 288-336) and its `clawCmd` shelling
  are out of scope and must not be touched — this task is entirely about which sessions get
  surfaced and how they're labeled, not about how the routing update is sent.
- Do not touch `lib/server/discord-api.js`. The actual message dispatch for
  `deliveryChannel: "discord"` happens inside the external openclaw/gateway cron engine, not
  in this repo. This task only makes the *destination picker* aware of Discord channels — it
  does not implement or modify how delivery is executed.
- Do not assume the external cron/gateway engine already supports posting to a bare guild
  channel ID via the `--channel discord --to <channelId>` flag combination. Verify this
  during integration testing (see Verifications); if delivery to a guild channel silently
  no-ops or errors, that is a separate, out-of-repo (openclaw core / gateway) issue to be
  reported, not something to work around inside AlphaClaw.
- No new database schema or local persistence. Sessions remain sourced live from the
  external CLI (`sessions --json --all-agents`) on every request; nothing is cached or
  stored in AlphaClaw's own DB (`lib/server/db/`).
- Do not add a free-text "enter any Discord channel ID" input. That was explicitly
  considered and ruled out during requirements discussion — this task is scoped to
  auto-population from prior conversation/session history only, matching how Telegram
  destinations already work.
- `getSessionReplyTarget()`'s existing Telegram regex branches must remain byte-for-byte
  unchanged; add the Discord case as a new, independent branch rather than restructuring
  the function.
- `parseChannelFromSessionKey()` (`session-keys.js:60-66`) already generically matches
  `:discord:` regardless of DM vs. channel kind — no change needed there.
- `sortSessionsByPriority` / `getSessionPriority` (`session-keys.js:27-45`) ordering behavior
  for existing `:direct:`/`:group:` destination kinds must not regress when `:channel:` is
  added as a recognized destination kind.
- `deliverySessionOptions` dedupe-by-label logic in `cron-job-settings-card.js:82-110` must
  continue to dedupe correctly — ensure the new Discord channel label is distinct enough
  (e.g. includes the channel ID) that two different channels are never accidentally
  deduped into one option.

## When You Need Human Feedback

(none — see Resolved Open Question below)

## Resolved Open Question (confirmed via live production test)

Confirmed on the `prod-peter` Railway service (2026-07-09) that the external cron/gateway
engine **already supports delivering to a bare Discord guild channel ID** — no additional
out-of-repo work is required on that side. Test performed:

- Created a disposable one-shot cron job directly via `openclaw cron add` over SSH
  (`--session isolated --message "..." --announce --channel discord --to 1487367106281476239
  --disabled --at +365d`), then triggered it manually with `openclaw cron run <id>` and
  inspected `openclaw cron runs --id <id>`.
- Confirmed `agent:main:discord:channel:1487367106281476239` already existed as a live
  session on this instance with `replyChannel`/`replyTo` empty — reproducing exactly the gap
  described above (this destination cannot be selected via the UI today, even though the
  gateway can deliver to it).
- Run result: `"delivered": true`, `"deliveryStatus": "delivered"`,
  `"delivery": { "intended": { "channel": "discord", "to": "1487367106281476239", "source":
  "explicit" }, "resolved": { "ok": true, "channel": "discord", "to":
  "channel:1487367106281476239", "accountId": "default" }, "delivered": true }`. A real
  message was posted to the guild channel.
- The one-shot job auto-removed itself (`deleteAfterRun: true`) after the successful run —
  no lingering job left on `prod-peter`.

This means the implementation work is scoped entirely to the frontend/session-listing gap
described above (`getSessionReplyTarget`, `isDestinationSessionKey`) — the delivery/dispatch
side needs no changes.
