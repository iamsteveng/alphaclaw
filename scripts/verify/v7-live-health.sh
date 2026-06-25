#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RAILWAY_URL:-}" ]]; then
  echo "SKIP WARNING: RAILWAY_URL not set — live URL health check skipped."
  exit 0
fi

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$RAILWAY_URL/health")
if [[ "$HTTP" == "200" ]]; then
  echo "PASS: $RAILWAY_URL/health returned 200"
else
  echo "FAIL: $RAILWAY_URL/health returned $HTTP (expected 200)"
  exit 1
fi
