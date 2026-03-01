#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="${1:-openclaw-railway-template-openclaw-1}"
CONFIG_PATH="${2:-/data/.openclaw/openclaw.json}"
INVALID_DIR="${3:-/tmp/does-not-exist}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not found in PATH" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | awk -v name="$CONTAINER_NAME" '$0 == name { found=1 } END { exit !found }'; then
  echo "Container not running: $CONTAINER_NAME" >&2
  echo "Tip: pass a container name as first arg." >&2
  exit 1
fi

docker exec "$CONTAINER_NAME" node -e "
const fs = require('fs');
const path = '$CONFIG_PATH';
const invalidDir = '$INVALID_DIR';
const raw = fs.readFileSync(path, 'utf8');
const cfg = JSON.parse(raw);
cfg.hooks = cfg.hooks || {};
cfg.hooks.transformDir = invalidDir;
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
console.log('Injected invalid hooks.transformDir for watchdog test');
console.log('config:', path);
console.log('hooks.transformDir:', cfg.hooks.transformDir);
"

