#!/usr/bin/env bash
set -euo pipefail

fail=0

for f in Dockerfile railway.toml entrypoint.sh docker-compose.yml; do
  if [[ ! -f "$f" ]]; then
    echo "FAIL: $f not found at repo root"
    fail=1
  else
    echo "PASS: $f present"
  fi
done

exit $fail
