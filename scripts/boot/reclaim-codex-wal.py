#!/usr/bin/env python3
"""Reclaim volume space held by the Codex app-server debug-log database.

Runs first in the container entrypoint, before anything writes to /data.
The Codex app-server keeps an unbounded debug log at
agents/<id>/agent/codex-home/logs_2.sqlite. A failed bulk delete or a held
reader can leave a write-ahead log (-wal) as large as the database itself,
which on a small volume means ENOSPC for every later write and a boot
failure. Strategy, per database:
  1. PRAGMA wal_checkpoint(TRUNCATE): commits pending frames and shrinks
     the -wal to zero. Non-destructive.
  2. If the -wal is still above WAL_CEILING afterwards (checkpoint could not
     complete, typically because the disk is full), delete the database and
     its sidecars. It holds Codex debug logs only; the app-server recreates
     it on start.
Never exits non-zero; the entrypoint must not fail because of this step.
"""
import glob, os, sqlite3, sys

STATE_DIR = os.environ.get("OPENCLAW_STATE_DIR") or os.path.join(os.environ.get("HOME", "/data"), ".openclaw")
WAL_CEILING = 256 * 1024 * 1024

def size(p):
    try:
        return os.path.getsize(p)
    except OSError:
        return 0

def main():
    pattern = os.path.join(STATE_DIR, "agents", "*", "agent", "codex-home", "logs_2.sqlite")
    for db in sorted(glob.glob(pattern)):
        wal, shm = db + "-wal", db + "-shm"
        before = size(db) + size(wal)
        try:
            conn = sqlite3.connect(db, timeout=30)
            res = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            conn.close()
            print(f"[reclaim-codex-wal] checkpoint {db}: busy/log/checkpointed={res}")
        except Exception as err:  # noqa: BLE001
            print(f"[reclaim-codex-wal] checkpoint failed for {db}: {err}")
        after_wal = size(wal)
        if after_wal > WAL_CEILING:
            removed = []
            for p in (db, wal, shm):
                try:
                    os.remove(p)
                    removed.append(os.path.basename(p))
                except FileNotFoundError:
                    pass
                except OSError as err:
                    print(f"[reclaim-codex-wal] could not remove {p}: {err}")
            print(f"[reclaim-codex-wal] -wal still {after_wal} bytes after checkpoint; removed {removed} (Codex debug log only, recreated on start)")
        print(f"[reclaim-codex-wal] {db}: {before} -> {size(db) + size(wal)} bytes")

if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001
        print(f"[reclaim-codex-wal] skipped: {err}")
    sys.exit(0)
