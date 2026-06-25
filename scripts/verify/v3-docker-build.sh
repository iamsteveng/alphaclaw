#!/usr/bin/env bash
set -euo pipefail

docker build --no-cache -t alphaclaw-monorepo-test:ci .
echo "PASS: docker build exited 0"

# The image must NOT contain a reference to the old split-repo install path
if docker run --rm alphaclaw-monorepo-test:ci cat /app/package.json \
    | grep -q '"github:iamsteveng/alphaclaw'; then
  echo "FAIL: image still installs alphaclaw from external GitHub SHA (old split-repo pattern)"
  exit 1
fi
echo "PASS: no external GitHub SHA dependency in image"
