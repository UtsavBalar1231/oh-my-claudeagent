#!/usr/bin/env python3
"""
omca-state MCP Server — Boulder, Evidence, and Notepad management.
Uses FastMCP for work plan tracking, verification evidence,
and subagent learning notepads.
"""

import json
import os
import signal
import subprocess
import sys
import time
from typing import Literal

from mcp.server.fastmcp import FastMCP
from pydantic import Field

# --- Constants ---

OMCA_STATE_DIR = ".omca/state"
BOULDER_FILE = "boulder.json"
EVIDENCE_FILE = "verification-evidence.json"
NOTEPADS_DIR = "notepads"
VALID_SECTIONS = ("learnings", "issues", "decisions", "problems", "questions")

# --- Helpers ---


class ToolError(Exception):
    pass


def _find_git_root(working_directory: str) -> str:
    """Resolve the git worktree root from a working directory."""
    cwd = working_directory if working_directory else os.getcwd()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, OSError):
        pass
    return cwd


def _state_dir(working_directory: str) -> str:
    """Return the .omca/state/ directory path."""
    root = _find_git_root(working_directory)
    return os.path.join(root, OMCA_STATE_DIR)


def _read_json(path: str) -> dict:
    """Read a JSON file, returning empty dict if missing or invalid."""
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_json(path: str, data: dict) -> None:
    """Atomically write JSON to a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


# --- Server ---

mcp = FastMCP("omca-state")


# --- Boulder tools ---


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def boulder_read(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Read current boulder state from .omca/state/boulder.json"""
    state = _state_dir(working_directory)
    path = os.path.join(state, BOULDER_FILE)
    data = _read_json(path)
    if not data:
        return "No active boulder state found."
    return json.dumps(data, indent=2)


@mcp.tool()
def boulder_write(
    active_plan: str = Field(description="Absolute path to the plan file"),
    plan_name: str = Field(description="Short name for the plan"),
    session_id: str = Field(description="Current session ID"),
    agent: str = Field(default="atlas", description="Agent managing this plan"),
    worktree_path: str = Field(
        default="", description="Git worktree path if using worktrees"
    ),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Create or update boulder state. Appends session_id to existing sessions."""
    state = _state_dir(working_directory)
    path = os.path.join(state, BOULDER_FILE)
    existing = _read_json(path)

    session_ids = existing.get("session_ids", [])
    if session_id not in session_ids:
        session_ids.append(session_id)

    data = {
        "active_plan": active_plan,
        "started_at": existing.get(
            "started_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        ),
        "session_ids": session_ids,
        "plan_name": plan_name,
        "agent": agent,
    }
    if worktree_path:
        data["worktree_path"] = worktree_path

    _write_json(path, data)
    return f"Boulder state written: plan={plan_name}, sessions={len(session_ids)}"


@mcp.tool(annotations={"destructiveHint": True})
def boulder_clear(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Remove boulder state file."""
    state = _state_dir(working_directory)
    path = os.path.join(state, BOULDER_FILE)
    try:
        os.remove(path)
        return "Boulder state cleared."
    except FileNotFoundError:
        return "No boulder state to clear."


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def boulder_progress(
    plan_path: str = Field(
        default="",
        description="Path to plan file (reads from boulder.json if empty)",
    ),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Parse plan file checkboxes and return progress summary."""
    if not plan_path:
        state = _state_dir(working_directory)
        boulder = _read_json(os.path.join(state, BOULDER_FILE))
        plan_path = boulder.get("active_plan", "")
        if not plan_path:
            return "No active plan found in boulder state."

    try:
        with open(plan_path) as f:
            content = f.read()
    except FileNotFoundError:
        raise ToolError(f"Plan file not found: {plan_path}") from None

    total = content.count("- [ ]") + content.count("- [x]")
    completed = content.count("- [x]")
    remaining = total - completed

    result = {
        "total": total,
        "completed": completed,
        "remaining": remaining,
        "is_complete": remaining == 0 and total > 0,
        "plan_path": plan_path,
    }
    return json.dumps(result, indent=2)


# --- Evidence tools ---


@mcp.tool()
def evidence_record(
    evidence_type: str = Field(
        description="Evidence type: build, test, lint, or manual. Called after verification commands."
    ),
    command: str = Field(description="Command that was executed"),
    exit_code: int = Field(description="Exit code of the command"),
    output_snippet: str = Field(
        description="Relevant output snippet (truncated if needed)"
    ),
    verified_by: str = Field(default="", description="Agent or user who verified"),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """REQUIRED after build/test/lint — task completion blocked without evidence. Append a timestamped verification evidence entry."""
    state = _state_dir(working_directory)
    path = os.path.join(state, EVIDENCE_FILE)
    data = _read_json(path)

    if "entries" not in data:
        data["entries"] = []

    entry = {
        "type": evidence_type,
        "command": command,
        "exit_code": exit_code,
        "output_snippet": output_snippet[:2000],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if verified_by:
        entry["verified_by"] = verified_by

    data["entries"].append(entry)
    _write_json(path, data)
    return f"Evidence recorded: {evidence_type} (exit {exit_code}), {len(data['entries'])} total entries"


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def evidence_read(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Read all verification evidence records."""
    state = _state_dir(working_directory)
    path = os.path.join(state, EVIDENCE_FILE)
    data = _read_json(path)
    if not data or not data.get("entries"):
        return "No verification evidence recorded."
    return json.dumps(data, indent=2)


@mcp.tool(annotations={"destructiveHint": True})
def evidence_clear(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Clear all verification evidence."""
    state = _state_dir(working_directory)
    path = os.path.join(state, EVIDENCE_FILE)
    try:
        os.remove(path)
        return "Verification evidence cleared."
    except FileNotFoundError:
        return "No evidence to clear."


# --- Notepad tools ---


def _notepad_dir(state: str, plan_name: str) -> str:
    """Return the notepad directory for a plan, creating it if needed."""
    d = os.path.join(state, NOTEPADS_DIR, plan_name)
    os.makedirs(d, exist_ok=True)
    return d


def _list_notepad_sections(directory: str) -> list[str]:
    """List notepad section names in a directory."""
    files = sorted(f for f in os.listdir(directory) if f.endswith(".md"))
    return [f.removesuffix(".md") for f in files]


@mcp.tool()
def omca_notepad_write(
    plan_name: str = Field(description="Plan name (matches boulder plan_name)"),
    section: Literal[
        "learnings", "issues", "decisions", "problems", "questions"
    ] = Field(description="Notepad section to write to"),
    content: str = Field(description="Content to append (markdown)"),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Append content to a notepad section. Always appends, never overwrites."""
    state = _state_dir(working_directory)
    d = _notepad_dir(state, plan_name)
    path = os.path.join(d, f"{section}.md")

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry = f"\n## {timestamp}\n\n{content}\n"

    with open(path, "a") as f:
        f.write(entry)

    return f"Appended to {plan_name}/{section}.md"


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def omca_notepad_read(
    plan_name: str = Field(description="Plan name"),
    section: Literal["learnings", "issues", "decisions", "problems", "questions"]
    | None = Field(default=None, description="Section to read (all if omitted)"),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Read notepad content for a plan. Returns one section or all."""
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
def omca_notepad_list(
    plan_name: str = Field(
        default="", description="Plan name (lists all plans if empty)"
    ),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """List available notepads and their sections."""
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


# --- Signal handling & entry point ---

signal.signal(signal.SIGINT, signal.SIG_IGN)


def _graceful_exit(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, _graceful_exit)

if __name__ == "__main__":
    print("omca-state MCP server starting", file=sys.stderr)
    mcp.run()
