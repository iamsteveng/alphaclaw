#!/usr/bin/env bash
# Rebuild the gbrain pglite database without data loss.
# Run inside the container (or via: docker exec -i <container> bash < scripts/gbrain-rebuild.sh)
#
# Steps: export all pages → backup pglite dir → wipe → reinit → reimport
#
# IMPORTANT: Stop the OpenClaw gateway BEFORE running this script so the
# gbrain MCP server (gbrain serve) is not holding the pglite directory open.

set -euo pipefail

GBRAIN_HOME="${GBRAIN_HOME:-/data}"
DB_PATH="/root/.gbrain/brain.pglite"
EXPORT_DIR="/tmp/gbrain-export-$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="${DB_PATH}.bak.$(date +%Y%m%d-%H%M%S)"

# env HOME=... gbrain is used instead of a bash function because `timeout` execs
# binaries directly and cannot call bash functions.
GBRAIN="env HOME=$GBRAIN_HOME gbrain"

echo "=== GBrain Database Rebuild ==="
echo "DB path:    $DB_PATH"
echo "Export dir: $EXPORT_DIR"
echo "Backup:     $BACKUP_PATH"
echo

# ── Phase 1: Guard ──────────────────────────────────────────────────────────
if pgrep -f "gbrain serve" > /dev/null 2>&1; then
  echo "ERROR: gbrain serve is still running. Stop the gateway first."
  echo "  Local:      npm run dev:restart (then re-run this script before gateway finishes booting)"
  echo "  Container:  pkill -f 'gbrain serve'"
  exit 1
fi

if [[ ! -d "$DB_PATH" ]]; then
  echo "No existing database found at $DB_PATH — nothing to rebuild."
  exit 0
fi

# ── Phase 2: Export ──────────────────────────────────────────────────────────
# Note: gbrain outputs results then the WASM process may hang (known pglite bug).
# Pipe through `head` so the kernel pipe buffer flushes output immediately; when
# head closes the read end, gbrain gets SIGPIPE and exits instead of hanging.
echo "--- Exporting pages ---"
mkdir -p "$EXPORT_DIR"

SLUGS_FILE=$(mktemp)
timeout 30 $GBRAIN list 2>/dev/null | head -n 100000 > "$SLUGS_FILE" || true
if [[ ! -s "$SLUGS_FILE" ]]; then
  echo "ERROR: gbrain list produced no output. Database may be unreadable."
  echo "  Falling back to backup-only mode (data preserved in backup, re-import not possible)."
  cp -a "$DB_PATH" "$BACKUP_PATH"
  echo "Backup saved to: $BACKUP_PATH"
  rm -f "$SLUGS_FILE"
  exit 2
fi

PAGE_COUNT=0
FAIL_COUNT=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  slug=$(echo "$line" | awk '{print $1}')
  [[ -z "$slug" ]] && continue
  safe_name=$(echo "$slug" | tr '/' '__')
  # head -c acts as a pass-through (10 MB limit) while forcing pipe buffering
  timeout 15 $GBRAIN get "$slug" 2>/dev/null | head -c 10485760 > "$EXPORT_DIR/${safe_name}.md" || true
  if [[ -s "$EXPORT_DIR/${safe_name}.md" ]]; then
    PAGE_COUNT=$((PAGE_COUNT + 1))
  else
    echo "  WARN: failed to export $slug"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    rm -f "$EXPORT_DIR/${safe_name}.md"
  fi
done < "$SLUGS_FILE"
rm -f "$SLUGS_FILE"

echo "Exported $PAGE_COUNT pages ($FAIL_COUNT failed) to $EXPORT_DIR"

if [[ $PAGE_COUNT -eq 0 ]]; then
  echo "ERROR: No pages exported. Aborting rebuild to avoid data loss."
  exit 3
fi

# ── Phase 3: Backup ──────────────────────────────────────────────────────────
echo "--- Backing up database ---"
cp -a "$DB_PATH" "$BACKUP_PATH"
echo "Backup saved to: $BACKUP_PATH"

# ── Phase 4: Wipe ────────────────────────────────────────────────────────────
echo "--- Wiping database ---"
rm -rf "$DB_PATH"
echo "Database directory removed."

# ── Phase 5: Reinitialize ────────────────────────────────────────────────────
echo "--- Reinitializing fresh database ---"
# head -n 1 closes the pipe immediately after first line, sending SIGPIPE to gbrain
timeout 30 $GBRAIN list 2>/dev/null | head -n 1 > /dev/null || true
echo "Database initialized."

# ── Phase 6: Reimport ────────────────────────────────────────────────────────
echo "--- Reimporting $PAGE_COUNT pages ---"
IMPORT_OK=0
for f in "$EXPORT_DIR"/*.md; do
  [[ -f "$f" ]] || continue
  safe_name=$(basename "$f" .md)
  slug=$(echo "$safe_name" | tr '__' '/')
  # put reads stdin, writes to pglite, then may hang — pipe stdout through head
  timeout 15 $GBRAIN put "$slug" < "$f" 2>/dev/null | head -n 10 > /dev/null || true
  IMPORT_OK=$((IMPORT_OK + 1))
done

# ── Phase 7: Verify ──────────────────────────────────────────────────────────
echo "--- Verifying reimport ---"
FINAL_COUNT=$(timeout 30 $GBRAIN list 2>/dev/null | head -n 100000 | wc -l | tr -d ' ')
IMPORT_FAIL=0
if [[ "$FINAL_COUNT" -lt "$PAGE_COUNT" ]]; then
  IMPORT_FAIL=$((PAGE_COUNT - FINAL_COUNT))
  IMPORT_OK=$FINAL_COUNT
fi

echo
echo "=== Rebuild complete ==="
echo "  Exported:    $PAGE_COUNT pages"
echo "  In new db:   $FINAL_COUNT pages"
echo "  Failed:      $IMPORT_FAIL"
echo "  Backup:      $BACKUP_PATH"
echo "  Export dir:  $EXPORT_DIR"
echo
if [[ $IMPORT_FAIL -gt 0 ]]; then
  echo "WARNING: $IMPORT_FAIL pages missing from rebuilt db. Check $EXPORT_DIR for the raw files."
fi
echo "Start the gateway to resume normal operation."
