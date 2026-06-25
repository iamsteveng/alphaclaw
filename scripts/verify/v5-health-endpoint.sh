#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SETUP_PASSWORD:-}" ]]; then
  echo "SKIP WARNING: SETUP_PASSWORD not set — skipping live container test"
  echo "  Set SETUP_PASSWORD to a non-empty value to enable this check."
  exit 0
fi

CONTAINER_ID=$(docker run -d \
  -e SETUP_PASSWORD="$SETUP_PASSWORD" \
  -p 13000:3000 \
  alphaclaw-monorepo-test:ci)

cleanup() { docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Waiting up to 60s for /health to return 200..."
for i in $(seq 1 30); do
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:13000/health || echo "000")
  if [[ "$HTTP" == "200" ]]; then
    echo "PASS: /health returned 200 after ~$((i * 2))s"
    exit 0
  fi
  sleep 2
done

echo "FAIL: /health did not return 200 within 60s (last HTTP status: $HTTP)"
exit 1
