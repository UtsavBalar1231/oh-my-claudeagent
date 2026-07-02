#!/usr/bin/env python3
"""Bash-callable GC shim: prune finished/orphaned unbound plans at SessionStart.

Usage: python3 boulder_gc.py [working_directory]

Self-healing for two stale-boulder failure modes the write-path GC never
reaches (it only runs on boulder_write, which idle projects never call):
a plan whose tasks are all complete but was never cleared, and a plan whose
file the platform deleted. Bindings protect live work: a plan any session is
still bound to is never pruned here.

Shares normalize()/plan_is_complete()/gc_prune_unbound() with boulder.py via
_boulder_core, and the same boulder.json.lock flock + mkstemp/os.replace
write discipline, so it can never race the MCP writer. Stdlib-only.
Fail-soft: prints a JSON summary (or {}) and always exits 0.
"""

import contextlib
import fcntl
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools._boulder_core import gc_prune_unbound, is_flat_schema, normalize
from tools._common import BOULDER_FILE, _read_json, _state_dir


def main() -> None:
    summary: dict = {}
    try:
        working_directory = (
            sys.argv[1]
            if len(sys.argv) > 1
            else os.environ.get("CLAUDE_PROJECT_ROOT", "")
        )
        state = _state_dir(working_directory)
        boulder_path = os.path.join(state, BOULDER_FILE)
        if not os.path.exists(boulder_path):
            print("{}")
            return

        lock_fd = os.open(boulder_path + ".lock", os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            raw = _read_json(boulder_path)
            registry = normalize(raw)
            pruned = gc_prune_unbound(registry)
            changed = bool(pruned["pruned_plans"] or pruned["pruned_bindings"])
            # Persist only when the GC removed something. An untouched flat
            # schema stays on disk as-is (migration is boulder_write's job);
            # a pruned one is written back in registry shape.
            if changed or (is_flat_schema(raw) and not registry["plans"]):
                fd, tmp_path = tempfile.mkstemp(
                    dir=state, prefix=".boulder-", suffix=".tmp"
                )
                try:
                    with os.fdopen(fd, "w") as f:
                        json.dump(registry, f, indent=2)
                        f.write("\n")
                    os.replace(tmp_path, boulder_path)
                except BaseException:
                    with contextlib.suppress(OSError):
                        os.remove(tmp_path)
                    raise
            summary = pruned
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
            os.close(lock_fd)
    except Exception:
        summary = {}
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
