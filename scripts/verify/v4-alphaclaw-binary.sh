#!/usr/bin/env bash
set -euo pipefail

if ! docker run --rm alphaclaw-monorepo-test:ci alphaclaw --version; then
  echo "FAIL: alphaclaw --version failed inside the image"
  exit 1
fi
echo "PASS: alphaclaw --version succeeded"
