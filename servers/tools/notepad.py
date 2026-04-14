"""Subagent learning notepad tools."""

import os
import tempfile
import time
from pathlib import Path
from typing import Literal

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import (
    NOTEPADS_DIR,
    VALID_SECTIONS,
    _list_notepad_sections,
    _notepad_dir,
    _state_dir,
)


def register(mcp: FastMCP) -> None:
    """Register all notepad tools on the given FastMCP instance."""

    @mcp.tool()
    def notepad_write(
        plan_name: str = Field(description="Plan name (matches boulder plan_name)"),
        section: Literal["learnings", "issues", "decisions", "problems"] = Field(
            description="Notepad section to write to"
        ),
        content: str = Field(description="Content to append (markdown)"),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Append content to a notepad section during plan execution. Use to record learnings, issues, decisions, or problems discovered while working. Always appends, never overwrites — safe to call multiple times. Returns confirmation with the updated section path."""
        state = _state_dir(working_directory)
        d = _notepad_dir(state, plan_name)
        path = os.path.join(d, f"{section}.md")

        # No sanitization needed — MCP tool results are not inserted into system prompts
        timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        entry = f"\n## {timestamp}\n\n{content}\n"

        with open(path, "a") as f:
            f.write(entry)

        # Warn if section file exceeds 50KB after write
        size = Path(path).stat().st_size
        result_msg = f"Appended to {plan_name}/{section}.md"
        if size > 50 * 1024:
            result_msg += f"\n[WARNING: section file is {size // 1024}KB — consider running notepad_compact to reduce size]"

        return result_msg

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
    def notepad_read(
        plan_name: str = Field(description="Plan name"),
        section: Literal["learnings", "issues", "decisions", "problems"] | None = Field(
            default=None, description="Section to read (all if omitted)"
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Read notepad content for a plan. Use to review discoveries, open questions, or prior decisions before continuing work on a plan. Omit section to read all sections at once. Returns formatted markdown content or a not-found message."""
        state = _state_dir(working_directory)
        d = os.path.join(state, NOTEPADS_DIR, plan_name)

        if not os.path.isdir(d):
            return f"No notepad found for plan: {plan_name}"

        sections = [section] if section else list(VALID_SECTIONS)
        output = []

        for s in sections:
            path = os.path.join(d, f"{s}.md")
            if os.path.isfile(path):
                with open(path) as f:
                    content = f.read()
                output.append(f"# {s.title()}\n\n{content}")

        if not output:
            return f"No notepad entries found for plan: {plan_name}"

        return "\n---\n\n".join(output)

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
    def notepad_list(
        plan_name: str = Field(
            default="", description="Plan name (lists all plans if empty)"
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """List available notepads and their sections. Use to discover which plans have notepad data or to verify a notepad was created. Provide plan_name to list sections for a specific plan, or omit to list all plans. Returns plan names with their available section names."""
        state = _state_dir(working_directory)
        notepads_root = os.path.join(state, NOTEPADS_DIR)

        if not os.path.isdir(notepads_root):
            return "No notepads found."

        if plan_name:
            d = os.path.join(notepads_root, plan_name)
            if not os.path.isdir(d):
                return f"No notepad found for plan: {plan_name}"
            sections = _list_notepad_sections(d)
            return f"Plan: {plan_name}\nSections: {', '.join(sections) if sections else 'empty'}"

        plans = sorted(
            d
            for d in os.listdir(notepads_root)
            if os.path.isdir(os.path.join(notepads_root, d))
        )
        if not plans:
            return "No notepads found."

        lines = ["Available notepads:\n"]
        for p in plans:
            d = os.path.join(notepads_root, p)
            sections = _list_notepad_sections(d)
            lines.append(f"- {p}: {', '.join(sections) if sections else 'empty'}")

        return "\n".join(lines)

    @mcp.tool()
    def notepad_compact(
        plan_name: str = Field(description="Plan name (matches boulder plan_name)"),
        section: Literal["learnings", "issues", "decisions", "problems"] = Field(
            description="Notepad section to compact"
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Compact a notepad section by truncating older entries, keeping the most recent lines. Use between plan phases when notepad sections grow large. Keeps the last 20 lines and prepends a count of removed entries. Returns compacted content summary."""
        state = _state_dir(working_directory)
        path = Path(state) / NOTEPADS_DIR / plan_name / f"{section}.md"
        if not path.exists():
            return f"Section '{section}' not found for plan '{plan_name}'"
        lines = path.read_text().strip().split("\n")
        if len(lines) <= 20:
            return f"Section '{section}' has {len(lines)} lines — no compaction needed"
        kept = lines[-20:]  # Keep last 20
        removed = len(lines) - 20
        compacted = (
            "\n".join([f"[Compacted: {removed} earlier entries removed]", *kept]) + "\n"
        )
        fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            os.write(fd, compacted.encode())
            os.close(fd)
            os.replace(tmp, path)
        except:
            os.close(fd)
            os.unlink(tmp)
            raise
        return f"Compacted '{section}': removed {removed} old entries, kept last 20"
