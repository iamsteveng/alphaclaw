#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_TOKEN:-}" ]]; then
  echo "SKIP WARNING: RAILWAY_TOKEN not set — Railway deployment check skipped."
  echo "  Set RAILWAY_TOKEN to enforce this check."
  exit 0
fi

# Ensure railway CLI is available
if ! command -v railway &>/dev/null; then
  echo "FAIL: 'railway' CLI not installed"
  exit 1
fi

echo "Polling Railway for latest deployment status (up to 10 minutes)..."
for i in $(seq 1 60); do
  STATUS=$(railway deployment list --json 2>/dev/null \
    | python3 -c "
import json, sys
deployments = json.load(sys.stdin)
if not deployments:
    print('NONE')
else:
    print(deployments[0]['status'])
")

  echo "  Attempt $i/60: status = $STATUS"

  if [[ "$STATUS" == "SUCCESS" ]]; then
    echo "PASS: Railway deployment status is SUCCESS"
    exit 0
  elif [[ "$STATUS" == "FAILED" || "$STATUS" == "CRASHED" ]]; then
    echo "FAIL: Railway deployment status is $STATUS"
    exit 1
  fi

  sleep 10
done

echo "FAIL: Railway deployment did not reach SUCCESS within 10 minutes"
exit 1
