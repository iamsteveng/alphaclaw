#!/usr/bin/env bash
set -euo pipefail

fail=0

# [build] builder must be "DOCKERFILE" (exact enum value Railway accepts)
if ! grep -q 'builder = "DOCKERFILE"' railway.toml; then
  echo "FAIL: railway.toml missing [build] builder = \"DOCKERFILE\""
  fail=1
else
  echo "PASS: builder = DOCKERFILE"
fi

# healthcheckPath must be present so Railway knows when the container is ready
if ! grep -q 'healthcheckPath' railway.toml; then
  echo "FAIL: railway.toml missing healthcheckPath"
  fail=1
else
  echo "PASS: healthcheckPath present"
fi

# dockerfilePath must point to the Dockerfile at repo root
if ! grep -q 'dockerfilePath' railway.toml; then
  echo "FAIL: railway.toml missing dockerfilePath"
  fail=1
else
  echo "PASS: dockerfilePath present"
fi

exit $fail
