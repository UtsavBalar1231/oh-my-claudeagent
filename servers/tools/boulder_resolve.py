#!/usr/bin/env python3
"""Bash-callable resolver shim: prints the bound-plan triple for a session id.

Usage: python3 boulder_resolve.py [session_id] [working_directory]

Shares the resolver ladder and session-id resolution with `boulder.py` (via
`_boulder_core` / `_common`) so bash consumers bind on the exact same plan the
Python writer would. Stdlib-only — no fastmcp/pydantic. Fail-soft: prints `{}`
and exits 0 on any error.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools._boulder_core import resolve_bound_plan
from tools._common import (
    BOULDER_FILE,
    _read_json,
    _resolve_session_id,
    _state_dir,
)


def main() -> None:
    result: dict = {}
    try:
        session_id = sys.argv[1] if len(sys.argv) > 1 else ""
        session_id = _resolve_session_id(session_id)
        # Fall back to CLAUDE_PROJECT_ROOT (platform-set, mirrors common.sh
        # HOOK_PROJECT_ROOT) so a hook that omits the arg still finds the
        # project's boulder.json instead of resolving against an unrelated cwd.
        working_directory = (
            sys.argv[2]
            if len(sys.argv) > 2
            else os.environ.get("CLAUDE_PROJECT_ROOT", "")
        )
        state = _state_dir(working_directory)
        data = _read_json(os.path.join(state, BOULDER_FILE))
        result = resolve_bound_plan(data, session_id)
    except Exception:
        result = {}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
