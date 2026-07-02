"""Read-only search over local Claude Code session transcripts.

Reads JSONL transcript files under ``~/.claude/projects/<slug>/`` — the
platform's own session storage, never written by this tool. Excerpts
returned may contain prior conversation content (whatever the user or
assistant said in scope), so treat output the same as any other transcript
read: local-machine, single-user context, not a public API.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field

from tools._common import _find_git_root

# 10 — readable default without flooding a caller's context.
DEFAULT_LIMIT = 10
# 50 — hard ceiling regardless of the requested limit.
MAX_LIMIT = 50
# 100 — chars of context on each side of a hit; ~200 char excerpts total.
EXCERPT_RADIUS = 100
_VALID_ROLES = ("user", "assistant", "tool")


def _slugify(path: str) -> str:
    """Mirror the platform's project-directory slug: every non-alphanumeric
    char becomes a dash. Same algorithm as scripts/lib/common.sh lines 105-107
    (bash reads it, this ports the identical semantic to Python)."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def _projects_root() -> Path:
    """Root of the platform's transcript store. Overridable via
    OMCA_TRANSCRIPTS_ROOT for tests; defaults to ~/.claude/projects."""
    override = os.environ.get("OMCA_TRANSCRIPTS_ROOT")
    if override:
        return Path(override)
    return Path.home() / ".claude" / "projects"


def _extract_texts(msg_type: str, content: object) -> list[tuple[str, str]]:
    """Return (role, text) pairs from a message's content field.

    A plain string content is attributed to the message's own type
    (user/assistant). A list of typed blocks is broken out further: `text`
    blocks keep the message role, `tool_use`/`tool_result` blocks are
    attributed to role "tool" since that is what a caller filtering by role
    actually means by "tool", regardless of which top-level message type
    the block happens to be nested in.
    """
    if isinstance(content, str):
        return [(msg_type, content)] if content else []
    if not isinstance(content, list):
        return []

    out: list[tuple[str, str]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text = block.get("text", "")
            if text:
                out.append((msg_type, text))
        elif btype == "tool_use":
            text = json.dumps(block.get("input", {}))
            out.append(("tool", text))
        elif btype == "tool_result":
            tc = block.get("content")
            if isinstance(tc, str):
                out.append(("tool", tc))
            elif isinstance(tc, list):
                for sub in tc:
                    if isinstance(sub, dict) and sub.get("type") == "text":
                        out.append(("tool", sub.get("text", "")))
    return out


def _search_file(
    path: Path, query_lower: str, role_filter: str
) -> list[dict[str, str]]:
    """Return matches from one transcript file, most recent turn first."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []

    matches: list[dict[str, str]] = []
    for line in reversed(lines):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        msg_type = record.get("type")
        if msg_type not in ("user", "assistant"):
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue

        for role, text in _extract_texts(msg_type, message.get("content")):
            if role_filter and role != role_filter:
                continue
            idx = text.lower().find(query_lower)
            if idx == -1:
                continue
            start = max(0, idx - EXCERPT_RADIUS)
            end = min(len(text), idx + len(query_lower) + EXCERPT_RADIUS)
            matches.append(
                {
                    "file": path.name,
                    "timestamp": record.get("timestamp", ""),
                    "role": role,
                    "excerpt": text[start:end],
                }
            )
    return matches


def register(mcp: FastMCP) -> None:
    """Register the session_search tool on the given FastMCP instance."""

    @mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
    def session_search(
        query: Annotated[
            str,
            Field(
                description="Case-insensitive substring to search for. No regex support."
            ),
        ],
        project_path: Annotated[
            str, Field(description="Project root (default: cwd's git root)")
        ] = "",
        role: Annotated[
            str,
            Field(
                description="Filter to one role: user, assistant, or tool. Empty = all roles."
            ),
        ] = "",
        limit: Annotated[
            int, Field(description="Max matches to return (default 10, hard max 50).")
        ] = DEFAULT_LIMIT,
    ) -> str:
        """Search local Claude Code session transcripts for a project. Read-only; scans only the resolved project's own transcript directory under ~/.claude/projects/<slug>/, never other projects. Matches are case-insensitive substrings (no regex) over user/assistant/tool turn text, extracted from the JSONL block structure so hits land in readable text rather than raw JSON. Returns bounded, capped-excerpt matches (~200 chars around each hit), newest turns first, with a truncation note when more matches exist than were returned. Malformed transcript lines are skipped silently. Privacy: reads local conversation history; excerpts may contain prior session content."""
        root = _find_git_root(project_path)
        slug = _slugify(root)
        transcripts_dir = _projects_root() / slug

        effective_limit = max(1, min(limit, MAX_LIMIT))
        role_filter = role if role in _VALID_ROLES else ""
        query_lower = query.lower()

        result: dict[str, object] = {
            "query": query,
            "project_path": root,
            "slug": slug,
            "matches": [],
            "truncated": False,
        }

        if not transcripts_dir.is_dir():
            result["note"] = f"no transcript directory found at {transcripts_dir}"
            return json.dumps(result, indent=2)

        files = sorted(
            transcripts_dir.glob("*.jsonl"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )

        collected: list[dict[str, str]] = []
        truncated = False
        for f in files:
            for m in _search_file(f, query_lower, role_filter):
                if len(collected) >= effective_limit:
                    truncated = True
                    break
                collected.append(m)
            if truncated:
                break

        result["matches"] = collected
        result["truncated"] = truncated
        if truncated:
            result["note"] = (
                f"[TRUNCATED] returned {len(collected)} of possibly more matches; "
                "raise limit (max 50) to see more"
            )
        return json.dumps(result, indent=2)
