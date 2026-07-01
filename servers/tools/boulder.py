"""Boulder plan tracking tools — session-bound plan registry."""

import calendar
import contextlib
import fcntl
import json
import os
import re
import tempfile
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools import _boulder_core
from tools._common import (
    BOULDER_FILE,
    _read_json,
    _resolve_session_id,
    _state_dir,
)

# Checkbox format: ^- \[([ x])\] \d+\.  (MULTILINE)
# Must match statusline/core.py _CHECKBOX_RE exactly.
_CHECKBOX_RE = re.compile(r"^- \[([ x])\] \d+\.", re.MULTILINE)

# 7d (604800s) — GC backstop for unbound plans/stale bindings. Primary GC for
# bindings is SessionEnd (session-cleanup.sh, a later track); this is a
# best-effort fallback so boulder.json doesn't grow unbounded between runs.
GC_MAX_AGE_SECONDS = 7 * 24 * 3600


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _iso_to_epoch(iso: str) -> float:
    """Parse a `_now_iso()`-formatted UTC timestamp to epoch seconds; 0.0 on failure."""
    try:
        return calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, TypeError):
        return 0.0


def _read_boulder(state_dir: str) -> dict:
    return _read_json(os.path.join(state_dir, BOULDER_FILE))


def _boulder_path(state_dir: str) -> str:
    return os.path.join(state_dir, BOULDER_FILE)


def _lock_path(state_dir: str) -> str:
    return os.path.join(state_dir, BOULDER_FILE + ".lock")


@contextlib.contextmanager
def _boulder_lock(state_dir: str):
    """Hold an exclusive flock on a SEPARATE lock file for the read-modify-write.

    Locking a separate file (not boulder.json itself) avoids the inode footgun
    where `os.replace` swaps the data file out from under a lock held on it.
    """
    os.makedirs(state_dir, exist_ok=True)
    fd = os.open(_lock_path(state_dir), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _write_boulder_atomic(state_dir: str, data: dict) -> None:
    """Atomically replace boulder.json via mkstemp+os.replace (not a fixed .tmp path).

    A fixed `.tmp` name is a concurrency footgun: two writers racing would
    collide on the same temp path even under the lock's protection window.
    """
    os.makedirs(state_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=state_dir, prefix=".boulder-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, _boulder_path(state_dir))
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp_path)
        raise


def _plan_is_complete(active_plan: str) -> bool:
    """Derive completion from plan-file checkboxes — no separate `completed_at` field."""
    if not active_plan:
        return False
    try:
        content = Path(active_plan).read_text()
    except OSError:
        return False
    matches = _CHECKBOX_RE.findall(content)
    return bool(matches) and all(m.lower() == "x" for m in matches)


def _gc_prune(plans: dict, bindings: dict) -> None:
    """Prune stale bindings and unbound-and-complete stale plans, in-place, under lock."""
    now = time.time()

    stale_sessions = [
        sid
        for sid, binding in bindings.items()
        if now - binding.get("bound_at", now) > GC_MAX_AGE_SECONDS
    ]
    for sid in stale_sessions:
        del bindings[sid]

    bound_plan_names = {b["plan_name"] for b in bindings.values()}
    stale_plans = [
        name
        for name, entry in plans.items()
        if name not in bound_plan_names
        and now - _iso_to_epoch(entry.get("started_at", "")) > GC_MAX_AGE_SECONDS
        and _plan_is_complete(entry.get("active_plan", ""))
    ]
    for name in stale_plans:
        del plans[name]


def _do_boulder_write(
    active_plan: str,
    plan_name: str,
    session_id: str,
    agent: str,
    worktree_path: str,
    working_directory: str,
) -> str:
    """Read-modify-write the registry under lock. Extracted from the MCP tool
    wrapper so tests can call it directly (e.g. from multiple threads)."""
    session_id = _resolve_session_id(session_id)
    state = _state_dir(working_directory)

    with _boulder_lock(state):
        registry = _boulder_core.normalize(_read_boulder(state))
        plans = registry["plans"]
        bindings = registry["bindings"]

        existing_plan = plans.get(plan_name, {})
        started_at = existing_plan.get("started_at") or _now_iso()
        session_ids = list(existing_plan.get("session_ids") or [])
        if session_id and session_id not in session_ids:
            session_ids.append(session_id)

        plan_entry: dict = {
            "active_plan": active_plan,
            "started_at": started_at,
            "session_ids": session_ids,
            "agent": agent or existing_plan.get("agent") or "sisyphus",
        }
        wt = worktree_path or existing_plan.get("worktree_path", "")
        if wt:
            plan_entry["worktree_path"] = wt
        plans[plan_name] = plan_entry

        if session_id:
            bindings[session_id] = {
                "plan_name": plan_name,
                "bound_at": int(time.time()),
            }

        _gc_prune(plans, bindings)

        _write_boulder_atomic(state, {"plans": plans, "bindings": bindings})

    return f"Boulder state written: plan={plan_name}, sessions={len(session_ids)}"


def _do_boulder_progress(
    plan_path: str,
    plan_name: str,
    session_id: str,
    working_directory: str,
) -> str:
    state = _state_dir(working_directory)
    if not plan_path:
        raw = _read_boulder(state)
        if plan_name:
            registry = _boulder_core.normalize(raw)
            plan_entry = registry["plans"].get(plan_name)
            plan_path = plan_entry.get("active_plan", "") if plan_entry else ""
        else:
            resolved = _boulder_core.resolve_bound_plan(
                raw, _resolve_session_id(session_id)
            )
            plan_path = resolved.get("active_plan", "")
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
        """Register an active work plan in the session-bound plan registry. Upserts plans[plan_name] (preserving started_at, appending session_id to its session_ids, no dup) and binds this session to it. Returns confirmation with plan name and session count."""
        return _do_boulder_write(
            active_plan, plan_name, session_id, agent, worktree_path, working_directory
        )

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
    def boulder_progress(
        plan_path: str = Field(
            default="",
            description="Path to plan file (resolves from boulder registry if empty)",
        ),
        plan_name: str = Field(
            default="",
            description="Named plan in the registry to check (bypasses session resolution)",
        ),
        session_id: str = Field(
            default="",
            description="Session ID used to resolve the bound plan when plan_path/plan_name are omitted",
        ),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Parse plan file checkboxes and return task progress summary. Use to check remaining work before claiming completion or to report plan status. Resolves the plan from the registry (by plan_name, or by this session's binding) when plan_path is omitted. Returns JSON with total, completed, remaining, is_complete, and plan_path fields."""
        return _do_boulder_progress(plan_path, plan_name, session_id, working_directory)
