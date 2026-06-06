"""Boulder work plan tracking and mode management tools."""

import hashlib
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import (
    _MODE_FILES,
    BOULDER_FILE,
    RALPH_STATE_FILE,
    ULTRAWORK_STATE_FILE,
    _clear_mode_files,
    _load_evidence,
    _read_json,
    _resolve_session_id,
    _state_dir,
    _write_json,
)

ACTIVE_STATUSES = {"active", "paused"}
COMPLETED_STATUSES = {"completed", "abandoned"}
FORBIDDEN_TASK_KEYS = {"__proto__", "prototype", "constructor"}


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _now_ms() -> int:
    return int(time.time() * 1000)


def _iso_to_ms(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _safe_task_key(task_key: str) -> str:
    key = task_key.strip()
    if not key or key in FORBIDDEN_TASK_KEYS:
        raise ValueError("task_key is empty or reserved")
    return key


def _new_work_id(plan_name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", plan_name.strip()).strip("-") or "work"
    return f"{slug}-{uuid.uuid4().hex[:12]}"


def _empty_state() -> dict:
    return {"schema_version": 2, "active_work_id": "", "works": {}}


def _session_origins_from_legacy(session_ids: list) -> dict:
    return {sid: "direct" for sid in session_ids if isinstance(sid, str) and sid}


def _make_work(
    *,
    work_id: str,
    active_plan: str,
    plan_name: str,
    session_ids: list[str] | None = None,
    session_origins: dict | None = None,
    agent: str = "sisyphus",
    worktree_path: str = "",
    started_at: str | None = None,
    updated_at: str | None = None,
    status: str = "active",
) -> dict:
    now = _now_iso()
    sessions = list(dict.fromkeys(session_ids or []))
    return {
        "work_id": work_id,
        "active_plan": active_plan,
        "plan_name": plan_name,
        "status": status
        if status in {"active", "completed", "paused", "abandoned"}
        else "active",
        "started_at": started_at or now,
        "updated_at": updated_at or now,
        "ended_at": "",
        "elapsed_ms": 0,
        "session_ids": sessions,
        "session_origins": session_origins or _session_origins_from_legacy(sessions),
        "agent": agent or "sisyphus",
        "worktree_path": worktree_path or "",
        "task_sessions": {},
    }


def _normalize_work(work_id: str, raw: dict) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    session_ids = raw.get("session_ids", [])
    if not isinstance(session_ids, list):
        session_ids = []
    session_ids = [sid for sid in session_ids if isinstance(sid, str) and sid]
    session_origins = raw.get("session_origins", {})
    if not isinstance(session_origins, dict):
        session_origins = _session_origins_from_legacy(session_ids)
    task_sessions = raw.get("task_sessions", {})
    if not isinstance(task_sessions, dict):
        task_sessions = {}
    task_sessions = {
        k: v
        for k, v in task_sessions.items()
        if isinstance(k, str) and k not in FORBIDDEN_TASK_KEYS and isinstance(v, dict)
    }
    work = _make_work(
        work_id=raw.get("work_id") or work_id,
        active_plan=raw.get("active_plan", ""),
        plan_name=raw.get("plan_name", ""),
        session_ids=session_ids,
        session_origins=session_origins,
        agent=raw.get("agent", "sisyphus"),
        worktree_path=raw.get("worktree_path", ""),
        started_at=raw.get("started_at"),
        updated_at=raw.get("updated_at"),
        status=raw.get("status", "active"),
    )
    work["ended_at"] = raw.get("ended_at", "") or ""
    work["elapsed_ms"] = int(raw.get("elapsed_ms") or 0)
    work["task_sessions"] = task_sessions
    return work


def _project_mirror(state: dict, active_work: dict | None) -> dict:
    for key in [
        "active_plan",
        "status",
        "started_at",
        "updated_at",
        "ended_at",
        "elapsed_ms",
        "session_ids",
        "session_origins",
        "plan_name",
        "agent",
        "worktree_path",
        "task_sessions",
    ]:
        state.pop(key, None)
    if active_work:
        state.update(
            {
                "active_plan": active_work.get("active_plan", ""),
                "status": active_work.get("status", "active"),
                "started_at": active_work.get("started_at", ""),
                "updated_at": active_work.get("updated_at", ""),
                "ended_at": active_work.get("ended_at", ""),
                "elapsed_ms": active_work.get("elapsed_ms", 0),
                "session_ids": active_work.get("session_ids", []),
                "session_origins": active_work.get("session_origins", {}),
                "plan_name": active_work.get("plan_name", ""),
                "agent": active_work.get("agent", "sisyphus"),
                "task_sessions": active_work.get("task_sessions", {}),
            }
        )
        if active_work.get("worktree_path"):
            state["worktree_path"] = active_work.get("worktree_path")
    return state


def _normalize_boulder_state(raw: dict) -> dict:
    if not raw:
        return _empty_state()
    if raw.get("schema_version") == 2 and isinstance(raw.get("works"), dict):
        works = {
            wid: _normalize_work(wid, work)
            for wid, work in raw.get("works", {}).items()
        }
        active_work_id = raw.get("active_work_id", "")
        if active_work_id not in works:
            active_work_id = next(
                (
                    wid
                    for wid, work in works.items()
                    if work.get("status") in ACTIVE_STATUSES
                ),
                "",
            )
        state = {"schema_version": 2, "active_work_id": active_work_id, "works": works}
        return _project_mirror(state, works.get(active_work_id))

    work_id = _new_work_id(raw.get("plan_name", "legacy"))
    work = _make_work(
        work_id=work_id,
        active_plan=raw.get("active_plan", ""),
        plan_name=raw.get("plan_name", ""),
        session_ids=raw.get("session_ids", [])
        if isinstance(raw.get("session_ids"), list)
        else [],
        session_origins=_session_origins_from_legacy(raw.get("session_ids", [])),
        agent=raw.get("agent", "sisyphus"),
        worktree_path=raw.get("worktree_path", ""),
        started_at=raw.get("started_at"),
        updated_at=raw.get("updated_at"),
    )
    state = {"schema_version": 2, "active_work_id": work_id, "works": {work_id: work}}
    return _project_mirror(state, work)


def _read_boulder_state(state_dir: str) -> dict:
    return _normalize_boulder_state(_read_json(os.path.join(state_dir, BOULDER_FILE)))


def _write_boulder_state(state_dir: str, state: dict) -> None:
    active = state.get("works", {}).get(state.get("active_work_id", ""))
    _write_json(os.path.join(state_dir, BOULDER_FILE), _project_mirror(state, active))


def _work_is_resumeable(work: dict) -> bool:
    return work.get("status") not in COMPLETED_STATUSES


def _find_existing_work(state: dict, plan_name: str, worktree_path: str) -> str:
    return _find_existing_work_for_plan(state, "", plan_name, worktree_path)


def _canonical_path_for_compare(path: str) -> str:
    if not path:
        return ""
    try:
        return str(Path(path).expanduser().resolve(strict=False))
    except Exception:
        return os.path.abspath(os.path.expanduser(path))


def _find_existing_work_for_plan(
    state: dict, active_plan: str, plan_name: str, worktree_path: str
) -> str:
    target_plan = _canonical_path_for_compare(active_plan)
    target_worktree = _canonical_path_for_compare(worktree_path)
    for work_id, work in state.get("works", {}).items():
        if not _work_is_resumeable(work):
            continue
        if work.get("plan_name") != plan_name:
            continue
        if (
            _canonical_path_for_compare(work.get("worktree_path", ""))
            != target_worktree
        ):
            continue
        if (
            target_plan
            and _canonical_path_for_compare(work.get("active_plan", "")) != target_plan
        ):
            continue
        return work_id
    return ""


def _resolve_work(state: dict, work_id: str = "") -> tuple[str, dict | None]:
    selected = work_id or state.get("active_work_id", "")
    work = state.get("works", {}).get(selected)
    return selected, work


def _complete_work(state: dict, work_id: str) -> dict:
    work = state["works"][work_id]
    if work.get("status") != "completed":
        now = _now_iso()
        work["status"] = "completed"
        work["ended_at"] = now
        work["updated_at"] = now
        started_ms = _iso_to_ms(work.get("started_at"))
        ended_ms = _iso_to_ms(now)
        work["elapsed_ms"] = (
            max(0, ended_ms - started_ms)
            if started_ms is not None and ended_ms is not None
            else 0
        )
    if state.get("active_work_id") == work_id:
        state["active_work_id"] = next(
            (
                wid
                for wid, item in state.get("works", {}).items()
                if _work_is_resumeable(item)
            ),
            "",
        )
    return work


def _resolve_plan_path(work: dict, working_directory: str) -> str:
    plan_path = work.get("active_plan", "")
    worktree_path = work.get("worktree_path", "")
    if not plan_path or not worktree_path:
        return plan_path
    try:
        state_dir = Path(_state_dir(working_directory))
        project_root = state_dir.parent.parent.resolve()
        active = Path(plan_path)
        rel = active.resolve().relative_to(project_root)
        candidate = Path(worktree_path) / rel
        if candidate.exists():
            return str(candidate)
    except Exception:
        pass
    return plan_path


def _extract_section(content: str, heading: str) -> list[str]:
    lines = content.splitlines()
    out: list[str] = []
    in_section = False
    heading_re = re.compile(rf"^##\s+{re.escape(heading)}\s*$", re.IGNORECASE)
    for line in lines:
        if heading_re.match(line):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if in_section:
            out.append(line)
    return out


def _parse_progress(content: str) -> dict:
    structured = bool(
        re.search(
            r"^##\s+(TODOs|Final Verification Wave)\b",
            content,
            re.MULTILINE | re.IGNORECASE,
        )
    )
    tasks: list[tuple[str, str]] = []
    if structured:
        todo_re = re.compile(
            r"^[-*]\s+\[([ xX])\]\s+((?:TODO\s+)?\d+\.\s+.*)$",
            re.IGNORECASE,
        )
        final_re = re.compile(
            r"^[-*]\s+\[([ xX])\]\s+(F\d+\.\s+.*)$",
            re.IGNORECASE,
        )
        for line in _extract_section(content, "TODOs"):
            match = todo_re.match(line)
            if match:
                tasks.append((match.group(1), match.group(2).strip()))
        for line in _extract_section(content, "Final Verification Wave"):
            match = final_re.match(line)
            if match:
                tasks.append((match.group(1), match.group(2).strip()))
    else:
        for match in re.finditer(
            r"^[-*]\s+\[([ xX])\]\s+(\d+\.\s+.*)$", content, re.MULTILINE
        ):
            tasks.append((match.group(1), match.group(2).strip()))
    total = len(tasks)
    completed = sum(1 for marker, _label in tasks if marker.lower() == "x")
    current_task = next((label for marker, label in tasks if marker.lower() != "x"), "")
    return {
        "total": total,
        "completed": completed,
        "remaining": total - completed,
        "is_complete": total > 0 and completed == total,
        "current_task": current_task,
    }


def _progress_for_work(work_id: str, work: dict, working_directory: str) -> dict:
    plan_path = _resolve_plan_path(work, working_directory)
    try:
        content = Path(plan_path).read_text()
    except Exception:
        return {"work_id": work_id, "plan_path": plan_path, "plan_missing": True}
    parsed = _parse_progress(content)
    parsed.update({"work_id": work_id, "plan_path": plan_path})
    return parsed


def _has_f4_approve(entries: list[dict], active_plan_sha: str) -> bool:
    """Return True if any evidence entry is an F4 APPROVE for the given plan SHA."""
    for entry in entries:
        if entry.get("plan_sha256", "") != active_plan_sha:
            continue
        if entry.get("type", "") != "final_verification_f4":
            continue
        if entry.get("exit_code", -1) != 0:
            continue
        verdict = str(entry.get("verdict", "")).strip().upper()
        if verdict == "APPROVE":
            return True
        snippet = entry.get("output_snippet", "").upper()
        if re.search(r"\bVERDICT\s*:\s*APPROVE\b", snippet):
            return True
    return False


def _maybe_auto_deactivate(
    state: str,
    active_plan_sha256: str,
    working_directory: str,
    work_id: str = "",
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
        boulder = _read_boulder_state(state)
        completed_work_id = work_id or boulder.get("active_work_id", "")
        if completed_work_id and completed_work_id in boulder.get("works", {}):
            _complete_work(boulder, completed_work_id)
        else:
            return {"auto_deactivated": False, "reason": "work_not_found"}
        active_remain = any(
            _work_is_resumeable(work) for work in boulder.get("works", {}).values()
        )
        modes = ["ralph", "ultrawork", "final_verify"]
        if not active_remain:
            modes.append("boulder")
        else:
            _write_boulder_state(state, boulder)
        cleared = _clear_mode_files(state, modes)
    except Exception:
        return {"auto_deactivated": False, "reason": "internal_error"}

    print(
        "omca: plan complete + F4 APPROVE detected; auto-cleared "
        "ralph/ultrawork/final_verify modes"
        + (
            "; boulder retained for other active works"
            if active_remain
            else "; boulder cleared"
        ),
        file=sys.stderr,
    )
    return {
        "auto_deactivated": True,
        "completed_work_id": completed_work_id,
        "cleared": cleared,
        "boulder_retained": active_remain,
    }


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
        session_id = _resolve_session_id(session_id)
        state = _state_dir(working_directory)
        existing = _read_boulder_state(state)

        work_id = _find_existing_work_for_plan(
            existing, active_plan, plan_name, worktree_path
        )
        if work_id:
            work = existing["works"][work_id]
            work["active_plan"] = active_plan
            work["status"] = "active"
            work["updated_at"] = _now_iso()
            work["agent"] = agent or work.get("agent", "sisyphus")
            if worktree_path:
                work["worktree_path"] = worktree_path
        else:
            work_id = _new_work_id(plan_name)
            work = _make_work(
                work_id=work_id,
                active_plan=active_plan,
                plan_name=plan_name,
                session_ids=[],
                session_origins={},
                agent=agent,
                worktree_path=worktree_path,
            )
            existing["works"][work_id] = work

        if session_id and session_id not in work["session_ids"]:
            work["session_ids"].append(session_id)
        if session_id:
            work.setdefault("session_origins", {})[session_id] = "direct"
        existing["active_work_id"] = work_id

        _write_boulder_state(state, existing)
        _mirror_plan(active_plan, working_directory)
        return f"Boulder state written: plan={plan_name}, work_id={work_id}, sessions={len(work['session_ids'])}"

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
    def boulder_list(
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """List resumeable boulder works with progress summaries."""
        state_dir = _state_dir(working_directory)
        state_data = _read_boulder_state(state_dir)
        options = []
        for work_id, work in state_data.get("works", {}).items():
            if not _work_is_resumeable(work):
                continue
            option = {
                "work_id": work_id,
                "plan_name": work.get("plan_name", ""),
                "status": work.get("status", ""),
                "updated_at": work.get("updated_at", ""),
                "session_count": len(work.get("session_ids", [])),
                "worktree_path": work.get("worktree_path", ""),
                "progress": _progress_for_work(work_id, work, working_directory),
            }
            options.append(option)
        return json.dumps(
            {
                "schema_version": 2,
                "active_work_id": state_data.get("active_work_id", ""),
                "counts": {
                    "total": len(state_data.get("works", {})),
                    "resumeable": len(options),
                    "completed": sum(
                        1
                        for work in state_data.get("works", {}).values()
                        if work.get("status") == "completed"
                    ),
                    "abandoned": sum(
                        1
                        for work in state_data.get("works", {}).values()
                        if work.get("status") == "abandoned"
                    ),
                },
                "resume_options": options,
            },
            indent=2,
        )

    @mcp.tool()
    def boulder_select(
        work_id: str = Field(description="Work ID to make active"),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Select an existing boulder work as active."""
        state_dir = _state_dir(working_directory)
        state_data = _read_boulder_state(state_dir)
        if work_id not in state_data.get("works", {}):
            return json.dumps(
                {"error": True, "message": f"Unknown work_id: {work_id}"}, indent=2
            )
        state_data["active_work_id"] = work_id
        state_data["works"][work_id]["status"] = "active"
        state_data["works"][work_id]["updated_at"] = _now_iso()
        _write_boulder_state(state_dir, state_data)
        return json.dumps({"selected": True, "active_work_id": work_id}, indent=2)

    @mcp.tool()
    def boulder_complete(
        work_id: str = Field(
            default="", description="Work ID to complete; defaults to active work"
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Mark a boulder work completed while preserving other works."""
        state_dir = _state_dir(working_directory)
        state_data = _read_boulder_state(state_dir)
        selected, work = _resolve_work(state_data, work_id)
        if not work:
            return json.dumps(
                {"error": True, "message": "No matching work found"}, indent=2
            )
        completed = _complete_work(state_data, selected)
        _write_boulder_state(state_dir, state_data)
        return json.dumps(
            {
                "completed": True,
                "completed_work_id": selected,
                "active_work_id": state_data.get("active_work_id", ""),
                "elapsed_ms": completed.get("elapsed_ms", 0),
            },
            indent=2,
        )

    @mcp.tool()
    def boulder_task_start(
        task_key: str = Field(description="Stable task key"),
        task_label: str = Field(description="Short task label"),
        task_title: str = Field(description="Human-readable task title"),
        session_id: str = Field(description="Session handling this task"),
        work_id: str = Field(
            default="", description="Work ID; defaults to active work"
        ),
        agent: str = Field(default="", description="Agent handling this task"),
        category: str = Field(default="", description="Task category"),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Upsert a running task session on a boulder work."""
        session_id = _resolve_session_id(session_id)
        try:
            key = _safe_task_key(task_key)
        except ValueError as exc:
            return json.dumps({"error": True, "message": str(exc)}, indent=2)
        state_dir = _state_dir(working_directory)
        state_data = _read_boulder_state(state_dir)
        selected, work = _resolve_work(state_data, work_id)
        if not work:
            return json.dumps(
                {"error": True, "message": "No matching work found"}, indent=2
            )
        tasks = work.setdefault("task_sessions", {})
        task = tasks.get(key, {})
        started_at = task.get("started_at") or _now_iso()
        started_ms = task.get("started_ms") or _now_ms()
        tasks[key] = {
            **task,
            "task_key": key,
            "task_label": task_label,
            "task_title": task_title,
            "session_id": session_id,
            "agent": agent,
            "category": category,
            "status": "running",
            "started_at": started_at,
            "started_ms": started_ms,
            "updated_at": _now_iso(),
            "ended_at": task.get("ended_at", ""),
            "elapsed_ms": task.get("elapsed_ms", 0),
        }
        work["updated_at"] = _now_iso()
        _write_boulder_state(state_dir, state_data)
        return json.dumps(
            {"started": True, "work_id": selected, "task_key": key}, indent=2
        )

    @mcp.tool()
    def boulder_task_end(
        task_key: str = Field(description="Stable task key"),
        work_id: str = Field(
            default="", description="Work ID; defaults to active work"
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Mark a task session completed and record elapsed_ms."""
        try:
            key = _safe_task_key(task_key)
        except ValueError as exc:
            return json.dumps({"error": True, "message": str(exc)}, indent=2)
        state_dir = _state_dir(working_directory)
        state_data = _read_boulder_state(state_dir)
        selected, work = _resolve_work(state_data, work_id)
        if not work or key not in work.get("task_sessions", {}):
            return json.dumps(
                {"error": True, "message": "No matching task found"}, indent=2
            )
        task = work["task_sessions"][key]
        task["status"] = "completed"
        task["ended_at"] = _now_iso()
        task["updated_at"] = task["ended_at"]
        task["elapsed_ms"] = max(
            0, _now_ms() - int(task.get("started_ms") or _now_ms())
        )
        work["updated_at"] = _now_iso()
        _write_boulder_state(state_dir, state_data)
        return json.dumps(
            {
                "completed": True,
                "work_id": selected,
                "task_key": key,
                "elapsed_ms": task["elapsed_ms"],
            },
            indent=2,
        )

    @mcp.tool()
    def boulder_progress(
        plan_path: str = Field(
            default="",
            description="Path to plan file (reads from boulder.json if empty)",
        ),
        work_id: str = Field(
            default="", description="Work ID to inspect; defaults to active work"
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Parse plan file checkboxes and return task progress summary. Use to check remaining work before claiming completion or to report plan status. Reads boulder.json for plan path if plan_path is omitted. Returns JSON with total, completed, remaining, is_complete, and plan_path fields."""
        state = _state_dir(working_directory)
        boulder = _read_boulder_state(state)
        selected_work_id = work_id
        selected_work = None
        if not plan_path:
            selected_work_id, selected_work = _resolve_work(boulder, work_id)
            if not selected_work:
                return "No active plan found in boulder state."
            plan_path = _resolve_plan_path(selected_work, working_directory)
        elif work_id:
            selected_work_id, selected_work = _resolve_work(boulder, work_id)

        try:
            with open(plan_path) as f:
                content = f.read()
        except FileNotFoundError:
            return json.dumps(
                {
                    "error": True,
                    "plan_missing": True,
                    "plan_path": plan_path,
                    "work_id": selected_work_id,
                    "message": f"Plan file not found: {plan_path}. The platform may have deleted it. Clear boulder state with mode_clear(mode='boulder') and select a new plan.",
                },
                indent=2,
            )

        active_plan_sha256 = hashlib.sha256(content.encode()).hexdigest()

        result = _parse_progress(content)
        result.update({"plan_path": plan_path, "work_id": selected_work_id})

        if result["is_complete"] and selected_work_id and plan_path and work_id:
            if not selected_work:
                result.update({"auto_deactivated": False, "reason": "work_not_found"})
            elif (
                Path(plan_path).resolve()
                != Path(_resolve_plan_path(selected_work, working_directory)).resolve()
            ):
                result.update(
                    {
                        "auto_deactivated": False,
                        "reason": "plan_path_work_mismatch",
                    }
                )
            else:
                result.update(
                    _maybe_auto_deactivate(
                        state, active_plan_sha256, working_directory, selected_work_id
                    )
                )
        elif result["is_complete"] and selected_work_id:
            result.update(
                _maybe_auto_deactivate(
                    state,
                    active_plan_sha256,
                    working_directory,
                    selected_work_id if work_id else "",
                )
            )
        elif result["is_complete"]:
            result.update(
                {
                    "auto_deactivated": False,
                    "reason": "explicit_plan_without_work_id",
                }
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
        raw_boulder_data = _read_json(os.path.join(state, BOULDER_FILE))
        boulder_data = _normalize_boulder_state(raw_boulder_data)
        resumeable_works = {
            wid: work
            for wid, work in boulder_data.get("works", {}).items()
            if _work_is_resumeable(work)
        }
        active_work_id = boulder_data.get("active_work_id", "")
        active_work = boulder_data.get("works", {}).get(active_work_id)
        boulder_section: dict = {"active": bool(resumeable_works)}
        if raw_boulder_data:
            boulder_section.update(boulder_data)
            active_plan = boulder_data.get("active_plan", "")
            boulder_section["active_work_id"] = active_work_id
            boulder_section["active_work"] = active_work or {}
            boulder_section["works_summary"] = [
                {
                    "work_id": wid,
                    "plan_name": work.get("plan_name", ""),
                    "status": work.get("status", ""),
                    "session_count": len(work.get("session_ids", [])),
                    "updated_at": work.get("updated_at", ""),
                }
                for wid, work in boulder_data.get("works", {}).items()
            ]
            boulder_section["resume_options"] = [
                item
                for item in boulder_section["works_summary"]
                if item["work_id"] in resumeable_works
            ]
            boulder_section["plan_exists"] = bool(
                active_plan and os.path.isfile(active_plan)
            )

        # Evidence
        entries = _load_evidence(state)
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
