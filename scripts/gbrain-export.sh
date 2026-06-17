#!/usr/bin/env bash
# Export all gbrain pglite pages to flat markdown files.
# Run inside the container (or via: docker exec -i <container> bash < scripts/gbrain-export.sh)
#
# This is the backup half of the gbrain disaster-recovery loop:
#   gbrain-export.sh  →  writes pglite → flat files (daily backup)
#   gbrain-rebuild.sh →  reads flat files → pglite (recovery on corruption)
#
# gbrain's MCP put_page writes to pglite only — flat files are NOT written
# automatically. This script must run periodically to keep flat files current.

set -euo pipefail

GBRAIN_HOME="${GBRAIN_HOME:-/data}"
BRAIN_DIR="${BRAIN_DIR:-/data/.openclaw/workspace/brain}"

echo "=== GBrain Export ==="
echo "Source: pglite (HOME=$GBRAIN_HOME)"
echo "Target: $BRAIN_DIR"
echo

# Pipe through head to force kernel pipe buffering — avoids WASM hang where
# gbrain outputs all results then never exits (known pglite bug).
# || PAGE_COUNT=0 guards against gbrain exiting 1 (e.g. "no brain configured") which
# would otherwise abort the script via set -euo pipefail.
PAGE_COUNT=$(timeout 30 env HOME="$GBRAIN_HOME" gbrain list 2>/dev/null | head -n 100000 | wc -l | tr -d ' ') || PAGE_COUNT=0
echo "Pages to export: $PAGE_COUNT"

if [[ "$PAGE_COUNT" -eq 0 ]]; then
  echo "No pages found — nothing to export."
  exit 0
fi

timeout 60 env HOME="$GBRAIN_HOME" gbrain export --dir "$BRAIN_DIR" 2>/dev/null | head -n 100000 || true

EXPORTED=$(find "$BRAIN_DIR" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
echo
echo "=== Export complete ==="
echo "  pglite pages: $PAGE_COUNT"
echo "  flat files:   $EXPORTED"
echo "  directory:    $BRAIN_DIR"
