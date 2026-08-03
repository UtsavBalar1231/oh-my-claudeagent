"""Filesystem read tool for subagent external path access.

MCP tools bypass Claude Code's sandbox path scoping that restricts
the built-in Read tool to the project root for depth-1 subagents.

TODO: Remove when Claude Code #29610 is fixed.
"""

from __future__ import annotations

import json
import time
from fnmatch import fnmatch
from itertools import islice
from pathlib import Path
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

# --- Constants ---
_MAX_FILE_SIZE = 3 * 1024 * 1024  # 3MB (only enforced when limit=0)
_BINARY_CHECK_SIZE = 8192  # 8KB
# 2000 chars — a minified bundle is one line; without a cap a single line
# can outweigh the whole read in the caller's context.
_MAX_LINE_CHARS = 2000
_AUDIT_LOG = ".omca/logs/file-access.jsonl"

_DENY_PATTERNS = [
    "**/.ssh/*",
    "**/.gnupg/*",
    "**/.aws/*",
    "**/.env",
    "**/.env.*",
    "**/credentials*",
    "**/*secret*",
    "**/id_rsa*",
    "**/id_ed25519*",
    "/etc/shadow",
    "/etc/gshadow",
]


def _safe_resolve(raw_path: str) -> tuple[Path, str | None]:
    """Resolve path, validate it's a regular file.

    Returns (resolved_path, error_message_or_None).
    """
    p = Path(raw_path).expanduser().resolve()
    if not p.exists():
        return p, f"File not found: {raw_path}"
    if p.is_dir():
        return p, f"Path is a directory, not a file: {raw_path}"
    if not p.is_file():
        # Rejects FIFOs, devices, sockets — prevents MCP server hangs
        return p, f"Not a regular file (device/pipe/socket): {raw_path}"
    return p, None


def _is_denied(path: Path) -> bool:
    """Check path against sensitive file denylist."""
    s = str(path)
    return any(fnmatch(s, pat) for pat in _DENY_PATTERNS)


def _is_binary(path: Path) -> bool:
    """Detect binary files via null-byte scan on first 8KB."""
    with open(path, "rb") as f:
        chunk = f.read(_BINARY_CHECK_SIZE)
    return b"\x00" in chunk


def _cap_line(line: str) -> str:
    """Strip the line terminator and cap length, marking any truncation."""
    line = line.rstrip("\r\n")
    if len(line) <= _MAX_LINE_CHARS:
        return line
    dropped = len(line) - _MAX_LINE_CHARS
    return f"{line[:_MAX_LINE_CHARS]}... [line truncated, {dropped} more chars]"


def _read_window(
    path: Path, encoding: str, offset: int, limit: int
) -> tuple[list[str], int, str]:
    """Stream the requested line window with encoding fallback.

    Only the window is held in memory; the lines before and after it are
    counted and discarded so the footer's total stays exact without
    materializing the file. Returns (window, total_lines, used_encoding).
    """
    span = None if limit <= 0 else limit
    offset = max(0, offset)
    for enc in [encoding, "latin-1"]:
        try:
            with open(path, encoding=enc) as f:
                skipped = sum(1 for _ in islice(f, offset))
                window = [_cap_line(line) for line in islice(f, span)]
                trailing = sum(1 for _ in f)
            return window, skipped + len(window) + trailing, enc
        except (UnicodeDecodeError, LookupError):
            continue
    return [], 0, encoding  # unreachable — latin-1 never fails


def _format_numbered(lines: list[str], offset: int) -> str:
    """Format lines with right-aligned 6-char line numbers (cat -n style)."""
    return "\n".join(
        f"{i:>6}\t{line}" for i, line in enumerate(lines, start=offset + 1)
    )


def _estimate_tokens(char_count: int) -> int:
    """Estimate token count from character count (conservative ~4 chars/token)."""
    return char_count // 4


def _human_size(n: int) -> str:
    """Format byte count as human-readable string."""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n //= 1024
    return f"{n:.1f} TB"


def _audit(path: str, allowed: bool) -> None:
    """Append to .omca/logs/file-access.jsonl (best-effort, never fails)."""
    try:
        log_path = Path.cwd() / _AUDIT_LOG
        log_path.parent.mkdir(parents=True, exist_ok=True)
        entry = json.dumps(
            {
                "path": path,
                "allowed": allowed,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
        with open(log_path, "a") as f:
            f.write(entry + "\n")
    except Exception:
        pass  # Audit is best-effort — never block the tool


def register(mcp: MCPServer) -> None:
    """Register filesystem read tools. TODO: Remove when Claude Code #29610 is fixed."""

    @mcp.tool(
        annotations=ToolAnnotations(
            read_only_hint=True, idempotent_hint=True, open_world_hint=False
        ),
        meta={
            "anthropic/searchHint": "read a file outside the project root, with line numbers and a token estimate"
        },
        structured_output=False,
    )
    def file_read(
        path: Annotated[str, Field(description="Absolute path to the file to read")],
        offset: Annotated[
            int,
            Field(
                description="0-based line offset. Use with limit to paginate large files (e.g. offset=500, limit=200 reads lines 501-700)"
            ),
        ] = 0,
        limit: Annotated[
            int,
            Field(
                description="Max lines to return. Default 5000. Set to 0 for unlimited (blocked for >3MB files). Use smaller values for targeted reads to save tokens."
            ),
        ] = 5000,
        encoding: Annotated[
            str,
            Field(description="File encoding (default utf-8, falls back to latin-1)"),
        ] = "utf-8",
    ) -> str:
        """Read a file with line numbers, token estimate footer, and offset/limit chunking.

        Bypasses the built-in Read tool's project-root scoping for subagents.
        The footer shows estimated token count and file size. For large files,
        use offset and limit to read targeted sections instead of the whole file.
        Default limit is 5000 lines. Lines longer than 2000 characters are cut
        off with a truncation marker.
        """
        # A negative offset reads from the start rather than erroring, so the
        # audit entry and the line numbering both stay on the normal path.
        offset = max(0, offset)

        # 1. Resolve and validate path (rejects devices, FIFOs, sockets)
        resolved, err = _safe_resolve(path)
        if err:
            _audit(path, allowed=False)
            return err

        # 2. Security denylist
        if _is_denied(resolved):
            _audit(path, allowed=False)
            return f"Access denied: {path} matches sensitive file pattern"

        # 3. Size guard — only block unlimited reads of huge files
        size = resolved.stat().st_size
        if limit == 0 and size > _MAX_FILE_SIZE:
            _audit(path, allowed=False)
            return (
                f"File too large for unlimited read: {_human_size(size)} "
                f"(max {_human_size(_MAX_FILE_SIZE)}). "
                f"Use offset and limit to read in chunks."
            )

        # 4. Binary detection
        if _is_binary(resolved):
            _audit(path, allowed=False)
            return f"Binary file detected: {path} ({_human_size(size)})"

        # 5. Stream the requested window with encoding fallback
        window, total, used_enc = _read_window(resolved, encoding, offset, limit)
        _audit(path, allowed=True)

        if total == 0:
            return "(empty file)"
        if offset >= total:
            return f"(offset {offset} exceeds file length of {total} lines)"

        result = _format_numbered(window, offset)

        # 7. Add metadata footer
        est_tokens = _estimate_tokens(size)
        footer_parts = [
            f"~{est_tokens} tokens ({_human_size(size)})",
            f"{total} lines total",
        ]
        if used_enc != encoding:
            footer_parts.append(f"encoding fallback: {used_enc}")
        if limit > 0 and offset + limit < total:
            next_offset = offset + limit
            footer_parts.append(
                f"{total - next_offset} more lines available "
                f"(use offset={next_offset} to continue)"
            )

        return result + f"\n\n({', '.join(footer_parts)})"
