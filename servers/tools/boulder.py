"""Boulder work plan tracking and mode management tools."""

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Literal

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import (
    _MODE_FILES,
    BOULDER_FILE,
    EVIDENCE_FILE,
    RALPH_STATE_FILE,
    ULTRAWORK_STATE_FILE,
    _clear_mode_files,
    _load_evidence,
    _read_json,
    _state_dir,
    _write_json,
)


def _has_f4_approve(entries: list[dict], active_plan_sha: str) -> bool:
    """Return True if any evidence entry is an F4 APPROVE for the given plan SHA."""
    for entry in entries:
        if entry.get("plan_sha256", "") != active_plan_sha:
            continue
        if not entry.get("type", "").startswith("final_verification_f4"):
            continue
        if entry.get("exit_code", -1) == 0:
            return True
        snippet = entry.get("output_snippet", "").upper()
        if "APPROVE" in snippet or "APPROVED" in snippet:
            return True
    return False


def _maybe_auto_deactivate(
    state: str,
    active_plan_sha256: str,
    working_directory: str,
) -> dict:
    """
    If F4 APPROVE evidence matches active plan, clear ralph/ultrawork/boulder/
    final_verify and return {auto_deactivated: True, cleared: [...]}.
    Never raises; always returns a dict safe to merge into boulder_progress result.
    """
    try:
        entries = _load_evidence(state)
    except Exception:
        return {"auto_deactivated": False, "reason": "evidence_read_failed"}

    if not _has_f4_approve(entries, active_plan_sha256):
        return {"auto_deactivated": False, "reason": "no_matching_f4_approve"}

    try:
        cleared = _clear_mode_files(
            state, ["ralph", "ultrawork", "boulder", "final_verify"]
        )
    except Exception:
        return {"auto_deactivated": False, "reason": "internal_error"}

    print(
        "omca: plan complete + F4 APPROVE detected; auto-cleared "
        "ralph/ultrawork/boulder/final_verify modes",
        file=sys.stderr,
    )
    return {"auto_deactivated": True, "cleared": cleared}


def _sha256_file(path: Path) -> str:
    """Return the hex SHA-256 digest of the file at path."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _mirror_plan(active_plan: str, working_directory: str) -> None:
    """
    Mirror active_plan between ~/.claude/plans/ and <project>/.omca/plans/.

    Direction:
    - canonical under ~/.claude/plans/  → mirror to <project>/.omca/plans/<basename>
    - canonical under .omca/plans/      → mirror to ~/.claude/plans/<basename>
    - any other path                    → skip silently (not an error)

    Idempotent: skips I/O when the mirror already has the same SHA as the source.
    Warn-and-proceed on read or write failures.
    Raises RuntimeError on persistent SHA mismatch after writing.
    """
    user_plans = Path.home() / ".claude" / "plans"

    # Resolve the source path to handle symlinks / relative segments
    try:
        src = Path(active_plan).resolve()
    except Exception:
        src = Path(active_plan)

    # Determine state dir for project-local path
    # Replicate _state_dir logic: resolve project root then strip state sub-path
    from tools._common import (
        _state_dir,
    )  # local import to avoid circular at module level

    state_dir = Path(_state_dir(working_directory))
    # state_dir ends with .omca/state — parent parent is project root
    project_root = state_dir.parent.parent
    project_plans = project_root / ".omca" / "plans"

    # Decide direction
    try:
        src.relative_to(user_plans)
        mirror_dir = project_plans
    except ValueError:
        try:
            src.relative_to(project_plans)
            mirror_dir = user_plans
        except ValueError:
            # Out-of-scheme path — skip silently
            return

    # Read source bytes
    try:
        src_bytes = src.read_bytes()
    except Exception as exc:
        print(
            f"WARN: boulder_write: could not read plan source for mirror: {exc}; continuing.",
            file=sys.stderr,
        )
        return

    src_sha = hashlib.sha256(src_bytes).hexdigest()
    mirror_path = mirror_dir / src.name

    # Idempotency check: skip if mirror already matches
    if mirror_path.exists():
        try:
            if hashlib.sha256(mirror_path.read_bytes()).hexdigest() == src_sha:
                return
        except Exception:
            pass  # If we can't read the mirror, attempt to overwrite it

    # Write mirror
    try:
        mirror_dir.mkdir(parents=True, exist_ok=True)
        tmp = mirror_dir / (src.name + ".tmp")
        tmp.write_bytes(src_bytes)
        tmp.replace(mirror_path)
    except Exception as exc:
        print(
            f"WARN: boulder_write: mirror write failed: {exc}; continuing.",
            file=sys.stderr,
        )
        return

    # Verify SHA matches
    try:
        mirror_sha = hashlib.sha256(mirror_path.read_bytes()).hexdigest()
    except Exception as exc:
        raise RuntimeError(
            f"boulder_write: SHA verification failed — could not read mirror: {exc}"
        ) from exc

    if mirror_sha != src_sha:
        # Attempt one re-copy before raising
        try:
            mirror_path.write_bytes(src_bytes)
            mirror_sha = hashlib.sha256(mirror_path.read_bytes()).hexdigest()
        except Exception as exc:
            raise RuntimeError(
                f"boulder_write: SHA mismatch after re-copy attempt: {exc}"
            ) from exc
        if mirror_sha != src_sha:
            raise RuntimeError(
                f"boulder_write: SHA mismatch after mirror write: src={src_sha} mirror={mirror_sha}"
            )


def register(mcp: FastMCP) -> None:
    """Register all boulder and mode tools on the given FastMCP instance."""

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
        _mirror_plan(active_plan, working_directory)
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

        active_plan_sha256 = hashlib.sha256(content.encode()).hexdigest()

        matches = re.findall(r"^- \[([ x])\] \d+\.", content, re.MULTILINE)
        total = len(matches)
        completed = sum(1 for m in matches if m == "x")
        remaining = total - completed

        result = {
            "total": total,
            "completed": completed,
            "remaining": remaining,
            "is_complete": remaining == 0 and total > 0,
            "plan_path": plan_path,
        }

        if result["is_complete"]:
            state = _state_dir(working_directory)
            result.update(
                _maybe_auto_deactivate(state, active_plan_sha256, working_directory)
            )

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
        mode: Literal[
            "ralph", "ultrawork", "boulder", "evidence", "final_verify", "all"
        ] = Field(
            default="all",
            description=(
                "Which state to clear: "
                "'ralph' (ralph-state.json), "
                "'ultrawork' (ultrawork-state.json), "
                "'boulder' (boulder.json), "
                "'evidence' (verification-evidence.json), "
                "'final_verify' (pending-final-verify.json), "
                "'all' (ralph + ultrawork + boulder + final_verify, NOT evidence)"
            ),
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Clear active mode state files. Use when ending a work session, cancelling ralph/ultrawork persistence, or resetting plan state. 'all' clears ralph + ultrawork + boulder + final_verify but NOT evidence (evidence is permanent audit trail). Returns summary of cleared and skipped state files."""
        state = _state_dir(working_directory)

        if mode == "all":
            mode_list = ["ralph", "ultrawork", "boulder", "final_verify"]
        else:
            mode_list = [mode]

        # Collect which modes exist before clearing (for "was active/inactive" status)
        active_status: dict[str, str] = {}
        for label in mode_list:
            filename = _MODE_FILES.get(label)
            if filename:
                data = _read_json(os.path.join(state, filename))
                active_status[label] = "was active" if bool(data) else "was inactive"

        cleared_labels = _clear_mode_files(state, mode_list)
        cleared_set = set(cleared_labels)

        cleared: list[str] = [
            f"{label} ({active_status.get(label, '')})" for label in cleared_labels
        ]
        skipped: list[str] = [
            f"{label} (not found)" for label in mode_list if label not in cleared_set
        ]

        parts: list[str] = []
        if cleared:
            parts.append(f"Cleared: {', '.join(cleared)}.")
        if skipped:
            parts.append(f"Skipped: {', '.join(skipped)}.")

        return " ".join(parts) if parts else "Nothing to clear."
