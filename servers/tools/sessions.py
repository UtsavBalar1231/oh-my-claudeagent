"""Read-only search over local Claude Code session transcripts.

Reads JSONL transcript files under ``~/.claude/projects/<slug>/`` — the
platform's own session storage, never written by this tool. Large tool
results are spilled by the platform to
``<slug>/<session>/tool-results/*.txt`` with only a preview left inline in
the JSONL, so those sidecar files are scanned too. Subagent transcripts
under ``<slug>/<session>/subagents/`` are out of scope: they are a separate
conversation tree, and folding them in would attribute another agent's turns
to this project's session history.

Excerpts returned may contain prior conversation content (whatever the user
or assistant said in scope), so treat output the same as any other
transcript read: local-machine, single-user context, not a public API.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Annotated

from mcp.server.mcpserver import MCPServer
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
# Raises the client's persist-to-disk threshold for this tool's text result.
# Bounded by MAX_LIMIT excerpts of ~200 chars plus JSON overhead, so 100000 is
# far above any real result and well under the client's 500000 ceiling.
TRANSCRIPT_MAX_RESULT_CHARS = 100_000
# The platform replaces a spilled tool result inline with a pointer to the
# sidecar plus a prefix of its body, so the same text lives in two places.
_SPILL_PATH_RE = re.compile(r"(/\S+/tool-results/[^\s/]+\.txt)")


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
    path: Path,
    query_lower: str,
    role_filter: str,
    spilled: frozenset[str],
) -> list[dict[str, str]]:
    """Return matches from one transcript file, most recent turn first.

    ``spilled`` holds the resolved paths of the sidecar files this same scan
    covers. An inline tool result pointing at one of them is skipped: the
    sidecar carries the whole body, the inline copy only a prefix of it, so
    reporting both would spend two of the caller's match slots on one result.
    """
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
            if role == "tool" and spilled:
                ref = _SPILL_PATH_RE.search(text)
                if ref and str(Path(ref.group(1)).resolve()) in spilled:
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


def _search_sidecar(path: Path, query_lower: str) -> list[dict[str, str]]:
    """Return the first match from one spilled tool-result file, role "tool".

    A sidecar file is the body of a single tool result, so it yields at most
    one match, the same as any other single turn text. Sidecars carry no
    timestamp of their own, so the file mtime stands in for one.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    idx = text.lower().find(query_lower)
    if idx == -1:
        return []

    start = max(0, idx - EXCERPT_RADIUS)
    end = min(len(text), idx + len(query_lower) + EXCERPT_RADIUS)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(path.stat().st_mtime))
    return [
        {
            "file": f"{path.parent.parent.name}/tool-results/{path.name}",
            "timestamp": stamp,
            "role": "tool",
            "excerpt": text[start:end],
        }
    ]


def register(mcp: MCPServer) -> None:
    """Register the session_search tool on the given MCPServer instance."""

    @mcp.tool(
        annotations=ToolAnnotations(
            read_only_hint=True, idempotent_hint=True, open_world_hint=False
        ),
        meta={
            "anthropic/searchHint": "search this project's past Claude Code session transcripts",
            "anthropic/maxResultSizeChars": TRANSCRIPT_MAX_RESULT_CHARS,
        },
        structured_output=False,
    )
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
        """Search local Claude Code session transcripts for a project. Read-only; scans only the resolved project's own transcript directory under ~/.claude/projects/<slug>/, never other projects. Matches are case-insensitive substrings (no regex) over user/assistant/tool turn text, extracted from the JSONL block structure so hits land in readable text rather than raw JSON. Returns bounded, capped-excerpt matches (~200 chars around each hit), newest turns first, with a truncation note when more matches exist than were returned. Malformed transcript lines are skipped silently. Large tool results that the platform spilled to <session>/tool-results/*.txt are scanned as well and reported with role "tool", ordered by file mtime since they carry no timestamp; the truncated inline copy of a scanned sidecar is not reported a second time; subagent transcripts under <session>/subagents/ are not scanned. Privacy: reads local conversation history; excerpts may contain prior session content."""
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

        # Sidecars only ever hold tool output, so a non-tool role filter skips
        # them outright. The single-level glob keeps subagents/ out of scope.
        sidecars: list[Path] = []
        if role_filter in ("", "tool"):
            sidecars = list(transcripts_dir.glob("*/tool-results/*.txt"))
        spilled = frozenset(str(f.resolve()) for f in sidecars)

        sources = [
            (f.stat().st_mtime, f, False) for f in transcripts_dir.glob("*.jsonl")
        ]
        sources += [(f.stat().st_mtime, f, True) for f in sidecars]
        sources.sort(key=lambda s: s[0], reverse=True)

        collected: list[dict[str, str]] = []
        truncated = False
        for _mtime, f, is_sidecar in sources:
            found = (
                _search_sidecar(f, query_lower)
                if is_sidecar
                else _search_file(f, query_lower, role_filter, spilled)
            )
            for m in found:
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
