"""Boulder plan tracking tools."""

import json
import os
import re
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import (
    BOULDER_FILE,
    _read_json,
    _resolve_session_id,
    _state_dir,
    _write_json,
)

# Checkbox format: ^- \[([ x])\] \d+\.  (MULTILINE)
# Must match statusline/core.py _CHECKBOX_RE exactly.
_CHECKBOX_RE = re.compile(r"^- \[([ x])\] \d+\.", re.MULTILINE)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _read_boulder(state_dir: str) -> dict:
    return _read_json(os.path.join(state_dir, BOULDER_FILE))


def _write_boulder(state_dir: str, data: dict) -> None:
    _write_json(os.path.join(state_dir, BOULDER_FILE), data)


def register(mcp: FastMCP) -> None:
    """Register boulder tools on the given FastMCP instance."""

    @mcp.tool()
    def boulder_write(
        active_plan: str = Field(description="Absolute path to the plan file"),
        plan_name: str = Field(description="Short name for the plan"),
        session_id: str = Field(description="Current session ID"),
        agent: str = Field(default="sisyphus", description="Agent managing this plan"),
        worktree_path: str = Field(
            default="", description="Git worktree path if using worktrees"
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Register an active work plan in boulder state. Appends session_id to existing sessions (no duplicates). Returns confirmation with plan name and session count."""
        session_id = _resolve_session_id(session_id)
        state = _state_dir(working_directory)
        existing = _read_boulder(state)

        # Preserve started_at across resumes; deduplicate session_ids
        started_at = existing.get("started_at") or _now_iso()
        session_ids = existing.get("session_ids", [])
        if not isinstance(session_ids, list):
            session_ids = []
        if session_id and session_id not in session_ids:
            session_ids.append(session_id)

        data: dict = {
            "active_plan": active_plan,
            "plan_name": plan_name,
            "started_at": started_at,
            "session_ids": session_ids,
            "agent": agent or existing.get("agent") or "sisyphus",
        }
        if worktree_path:
            data["worktree_path"] = worktree_path
        elif existing.get("worktree_path"):
            data["worktree_path"] = existing["worktree_path"]

        _write_boulder(state, data)
        return f"Boulder state written: plan={plan_name}, sessions={len(session_ids)}"

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
        """Parse plan file checkboxes and return task progress summary. Use to check remaining work before claiming completion or to report plan status. Reads boulder.json for plan path if plan_path is omitted. Returns JSON with total, completed, remaining, is_complete, and plan_path fields."""
        state = _state_dir(working_directory)
        if not plan_path:
            boulder = _read_boulder(state)
            plan_path = boulder.get("active_plan", "")
            if not plan_path:
                return "No active plan found in boulder state."

        try:
            content = Path(plan_path).read_text()
        except FileNotFoundError:
            return json.dumps(
                {
                    "error": True,
                    "plan_missing": True,
                    "plan_path": plan_path,
                    "message": f"Plan file not found: {plan_path}.",
                },
                indent=2,
            )

        matches = _CHECKBOX_RE.findall(content)
        total = len(matches)
        completed = sum(1 for m in matches if m.lower() == "x")
        remaining = total - completed
        return json.dumps(
            {
                "total": total,
                "completed": completed,
                "remaining": remaining,
                "is_complete": total > 0 and completed == total,
                "plan_path": plan_path,
            },
            indent=2,
        )
