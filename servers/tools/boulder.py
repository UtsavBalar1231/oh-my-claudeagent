"""Boulder work plan tracking and mode management tools."""

import json
import os
import time
from typing import Literal

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import (
    BOULDER_FILE,
    EVIDENCE_FILE,
    RALPH_STATE_FILE,
    ULTRAWORK_STATE_FILE,
    _read_json,
    _state_dir,
    _write_json,
)


def register(mcp: FastMCP) -> None:
    """Register all boulder and mode tools on the given FastMCP instance."""

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
        """Register an active work plan in boulder state. Use when starting plan execution to enable ralph persistence, progress tracking, and subagent context injection. Appends session_id to existing sessions so multi-session plans accumulate history. Returns confirmation with plan name and session count."""
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
            return json.dumps(
                {
                    "error": True,
                    "plan_missing": True,
                    "plan_path": plan_path,
                    "message": f"Plan file not found: {plan_path}. The platform may have deleted it. Clear boulder state with mode_clear(mode='boulder') and select a new plan.",
                },
                indent=2,
            )

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

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
    def mode_read(
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Read all active mode state: ralph, ultrawork, boulder, and evidence. Use at session start to understand current execution context, or before making decisions that depend on active modes. Returns a unified JSON dashboard with active flags and latest entries per mode."""
        state = _state_dir(working_directory)

        # Ralph
        ralph_data = _read_json(os.path.join(state, RALPH_STATE_FILE))
        ralph_section: dict = {"active": bool(ralph_data)}
        if ralph_data:
            ralph_section.update(ralph_data)

        # Ultrawork
        ultrawork_data = _read_json(os.path.join(state, ULTRAWORK_STATE_FILE))
        ultrawork_section: dict = {"active": bool(ultrawork_data)}
        if ultrawork_data:
            ultrawork_section.update(ultrawork_data)

        # Boulder
        boulder_data = _read_json(os.path.join(state, BOULDER_FILE))
        boulder_section: dict = {"active": bool(boulder_data)}
        if boulder_data:
            boulder_section.update(boulder_data)
            active_plan = boulder_data.get("active_plan", "")
            boulder_section["plan_exists"] = bool(
                active_plan and os.path.isfile(active_plan)
            )

        # Evidence
        evidence_data = _read_json(os.path.join(state, EVIDENCE_FILE))
        entries = evidence_data.get("entries", [])
        evidence_section: dict = {
            "active": bool(entries),
            "entry_count": len(entries),
        }
        if entries:
            evidence_section["latest"] = entries[-1]

        result = {
            "ralph": ralph_section,
            "ultrawork": ultrawork_section,
            "boulder": boulder_section,
            "evidence": evidence_section,
        }
        return json.dumps(result, indent=2)

    @mcp.tool(annotations={"destructiveHint": True})
    def mode_clear(
        mode: Literal["ralph", "ultrawork", "boulder", "evidence", "all"] = Field(
            default="all",
            description=(
                "Which state to clear: "
                "'ralph' (ralph-state.json), "
                "'ultrawork' (ultrawork-state.json), "
                "'boulder' (boulder.json), "
                "'evidence' (verification-evidence.json), "
                "'all' (ralph + ultrawork + boulder, NOT evidence)"
            ),
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Clear active mode state files. Use when ending a work session, cancelling ralph/ultrawork persistence, or resetting plan state. 'all' clears ralph + ultrawork + boulder but NOT evidence (evidence is permanent audit trail). Returns summary of cleared and skipped state files."""
        state = _state_dir(working_directory)

        targets: list[tuple[str, str]] = []
        if mode == "ralph":
            targets = [("ralph", RALPH_STATE_FILE)]
        elif mode == "ultrawork":
            targets = [("ultrawork", ULTRAWORK_STATE_FILE)]
        elif mode == "boulder":
            targets = [("boulder", BOULDER_FILE)]
        elif mode == "evidence":
            targets = [("evidence", EVIDENCE_FILE)]
        else:  # all
            targets = [
                ("ralph", RALPH_STATE_FILE),
                ("ultrawork", ULTRAWORK_STATE_FILE),
                ("boulder", BOULDER_FILE),
            ]

        cleared: list[str] = []
        skipped: list[str] = []

        for label, filename in targets:
            path = os.path.join(state, filename)
            try:
                # Check if active before removing
                data = _read_json(path)
                was_active = bool(data)
                os.remove(path)
                status = "was active" if was_active else "was inactive"
                cleared.append(f"{label} ({status})")
            except FileNotFoundError:
                skipped.append(f"{label} (not found)")

        parts: list[str] = []
        if cleared:
            parts.append(f"Cleared: {', '.join(cleared)}.")
        if skipped:
            parts.append(f"Skipped: {', '.join(skipped)}.")

        return " ".join(parts) if parts else "Nothing to clear."
