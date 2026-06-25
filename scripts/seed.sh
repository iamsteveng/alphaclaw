#!/usr/bin/env bash
set -euo pipefail

SEED_ENV="$(cd "$(dirname "$0")/.." && pwd)/data-seed/.env"
VOLUME="alpha-claw_openclaw-data"

if [ ! -f "$SEED_ENV" ]; then
  echo "ERROR: data-seed/.env not found."
  echo ""
  echo "Pull it from your live Railway deployment:"
  echo "  railway run cat /data/.env > data-seed/.env"
  echo ""
  echo "Or create it manually with at minimum:"
  echo "  SETUP_PASSWORD=<value>"
  exit 1
fi

echo "Seeding Docker volume '$VOLUME' from data-seed/.env..."

# Write the env file into the volume via a temporary container
docker run --rm \
  -v "$VOLUME:/data" \
  -v "$SEED_ENV:/seed/.env:ro" \
  node:22-slim \
  bash -c "mkdir -p /data && cp /seed/.env /data/.env && echo 'Seeded /data/.env OK.'"

echo "Done. Run 'docker compose up --build' to start."
