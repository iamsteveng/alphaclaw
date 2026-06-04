#!/usr/bin/env bash
# Shared helpers for trading advisor integration tests.

PORT="${PORT:-3001}"
PASSWORD="${SETUP_PASSWORD:-62875094}"
AC_COOKIES="/tmp/ac-test7-cookies.txt"
CONTAINER="${CONTAINER:-openclaw-railway-template-openclaw-1}"

# Override gbrain to run inside the container — the host gbrain connects to a
# different pglite database (/home/ubuntu/.gbrain/brain.pglite) than the agent
# inside the container (/root/.gbrain/brain.pglite). All seed/assert operations
# must target the container's database so the agent can see them.
# Only "put" uses -i (reads stdin). Other subcommands must NOT use -i so they
# don't accidentally consume piped stdin meant for the test's confirm prompts.
gbrain() {
  if [[ "${1:-}" == "put" ]]; then
    docker exec -i "$CONTAINER" gbrain "$@"
  else
    docker exec "$CONTAINER" gbrain "$@"
  fi
}

ac_login() {
  curl -s -c "$AC_COOKIES" -X POST "http://localhost:$PORT/api/auth/login" \
    -H "Content-Type: application/json" -d "{\"password\":\"$PASSWORD\"}" > /dev/null
}

ac_ensure_crons() {
  local telegram_to
  telegram_to=$(curl -s -b "$AC_COOKIES" "http://localhost:$PORT/api/agent/sessions" | python3 -c "
import json,sys
data=json.load(sys.stdin)
for s in data.get('sessions',[]):
    if s.get('channel')=='telegram' and s.get('replyTo'):
        print(s['replyTo']); break
" 2>/dev/null || true)
  [[ -z "$telegram_to" ]] && { echo "Error: No Telegram session found"; return 1; }
  curl -s -b "$AC_COOKIES" -X POST "http://localhost:$PORT/api/trading-crons/ensure" \
    -H "Content-Type: application/json" \
    -d "{\"deliveryChannel\":\"telegram\",\"deliveryTo\":\"$telegram_to\"}" > /dev/null
}

ac_run_cron() {
  local name="$1"
  echo "--> Triggering $name cron..."
  curl -s -b "$AC_COOKIES" -X POST "http://localhost:$PORT/api/trading-crons/run/$name" \
    -H "Content-Type: application/json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('ok' if d.get('ok') else 'failed: '+str(d.get('error','')))
" 2>/dev/null || echo "request failed"
}

ac_remove_crons() {
  curl -s -b "$AC_COOKIES" -X DELETE "http://localhost:$PORT/api/trading-crons" > /dev/null 2>&1 || true
}

# gbrain_seed <slug> — restore (if soft-deleted) then put content from stdin.
# gbrain put silently updates soft-deleted pages without restoring them;
# this wrapper ensures the page is visible to the agent after seeding.
gbrain_seed() {
  local slug="$1"
  local content
  content=$(cat)
  gbrain restore "$slug" 2>/dev/null || true
  echo "$content" | gbrain put "$slug"
}
