#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SETUP_PASSWORD:-}" ]]; then
  echo "SKIP WARNING: SETUP_PASSWORD not set — docker compose test skipped."
  exit 0
fi

export SETUP_PASSWORD

docker compose up -d --build

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Waiting up to 90s for docker compose services to become healthy..."
for i in $(seq 1 45); do
  STATUS=$(docker compose ps --format json 2>/dev/null \
    | python3 -c "
import json, sys
lines = [l for l in sys.stdin.read().strip().splitlines() if l]
services = [json.loads(l) for l in lines]
states = [s.get('State','') for s in services]
print(','.join(states))
" 2>/dev/null || echo "unknown")
  echo "  Attempt $i/45: states = $STATUS"
  if echo "$STATUS" | grep -qv "starting" && echo "$STATUS" | grep -q "running"; then
    echo "PASS: docker compose services are running"
    exit 0
  fi
  sleep 2
done

echo "FAIL: docker compose services did not reach running state within 90s"
exit 1
