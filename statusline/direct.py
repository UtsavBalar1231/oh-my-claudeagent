"""Direct mode entry point for Claude Code statusline.

Reads JSON from stdin, renders the statusline, prints output.
No daemon interaction -- always renders inline.
"""

from __future__ import annotations

import json
import sys

from statusline.core import FALLBACK, render
from statusline.git import get_git_info
from statusline.usage import get_usage


def main() -> None:
    try:
        try:
            data = json.load(sys.stdin)
        except (json.JSONDecodeError, ValueError):
            print(FALLBACK)
            return

        if not isinstance(data, dict) or not data.get("model"):
            print(FALLBACK)
            return

        workspace = data.get("workspace", {})
        project_dir = workspace.get("project_dir", data.get("cwd", ""))
        git_info = get_git_info(project_dir) if project_dir else {}
        usage = get_usage()

        output = render(data, git_info, usage)
        print(output)
    except Exception:
        print("[claude]")


if __name__ == "__main__":
    main()
