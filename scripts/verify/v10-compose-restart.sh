#!/usr/bin/env bash
set -euo pipefail

START=$(date +%s)
docker compose restart
END=$(date +%s)
ELAPSED=$((END - START))

if [[ $ELAPSED -le 15 ]]; then
  echo "PASS: docker compose restart completed in ${ELAPSED}s (<= 15s)"
else
  echo "FAIL: docker compose restart took ${ELAPSED}s (> 15s — may be rebuilding)"
  exit 1
fi
