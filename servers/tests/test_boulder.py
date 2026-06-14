"""Tests for boulder and mode MCP tools."""

import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import boulder as boulder_module
from tools._common import (
    BOULDER_FILE,
    PENDING_FINAL_VERIFY_FILE,
    RALPH_STATE_FILE,
    ULTRAWORK_STATE_FILE,
    _write_json,
)


def call_tool(server: FastMCP, name: str, args: dict) -> str:
    """Call an MCP tool synchronously and return the text result."""
    result = asyncio.run(server.call_tool(name, args))
    # result is (list[ContentBlock], {'result': str})
    return result[1]["result"]


@pytest.fixture
def mcp_server():
    """Create a FastMCP server with boulder tools registered."""
    server = FastMCP("test-boulder")
    boulder_module.register(server)
    return server


# --- boulder_write ---


def test_boulder_write_creates_state_file(mcp_server, working_dir, tmp_git_root):
    """boulder_write creates boulder.json with correct schema."""
    result = call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )
    assert "my-plan" in result
    assert "sessions=1" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    assert path.exists()
    data = json.loads(path.read_text())
    assert data["plan_name"] == "my-plan"
    assert data["active_plan"] == "/tmp/plan.md"
    assert data["session_ids"] == ["sess-001"]
    assert "started_at" in data
    assert "agent" in data


def test_boulder_write_appends_sessions(mcp_server, working_dir, tmp_git_root):
    """boulder_write with two different session IDs appends to session_ids."""
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )
    result = call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-002",
            "working_directory": working_dir,
        },
    )
    assert "sessions=2" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    assert "sess-001" in data["session_ids"]
    assert "sess-002" in data["session_ids"]


def test_boulder_write_preserves_started_at(mcp_server, working_dir, tmp_git_root):
    """Second boulder_write call preserves original started_at timestamp."""
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )
    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    first_started_at = json.loads(path.read_text())["started_at"]

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-002",
            "working_directory": working_dir,
        },
    )
    second_started_at = json.loads(path.read_text())["started_at"]
    assert first_started_at == second_started_at


# --- boulder_progress ---


def test_boulder_progress_reads_plan_checkboxes(mcp_server, working_dir, tmp_path):
    """boulder_progress parses plan file checkboxes and returns task counts."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(
        "# My Plan\n\n- [x] 1. Task one done\n- [ ] 2. Task two pending\n- [ ] 3. Task three pending\n"
    )

    # Write boulder state pointing to the plan file
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "progress-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["total"] == 3
    assert data["completed"] == 1
    assert data["remaining"] == 2
    assert data["is_complete"] is False
    assert data["plan_path"] == str(plan_file)


def test_boulder_progress_ignores_final_checklist(mcp_server, working_dir, tmp_path):
    """boulder_progress counts only numbered tasks; Final Checklist checkboxes are ignored."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(
        "# My Plan\n\n"
        "## Tasks\n\n"
        "- [x] 1. Task one done\n"
        "- [ ] 2. Task two pending\n"
        "- [ ] 3. Task three pending\n\n"
        "### Final Checklist\n\n"
        "- [x] Review docs\n"
        "- [ ] Notify stakeholders\n"
    )

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "checklist-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    # Only the 3 numbered tasks count; the 2 Final Checklist items are ignored
    assert data["total"] == 3
    assert data["completed"] == 1
    assert data["remaining"] == 2
    # is_complete is False because numbered task 2 and 3 are still pending
    assert data["is_complete"] is False


def test_boulder_progress_complete_with_pending_final_checklist(
    mcp_server, working_dir, tmp_path
):
    """boulder_progress reports is_complete=True when all numbered tasks are done, even with pending Final Checklist items."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(
        "# My Plan\n\n"
        "## Tasks\n\n"
        "- [x] 1. Task one done\n"
        "- [x] 2. Task two done\n\n"
        "### Final Checklist\n\n"
        "- [ ] Review docs\n"
        "- [ ] Notify stakeholders\n"
    )

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "all-done-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    # Both numbered tasks are complete; Final Checklist items don't count
    assert data["total"] == 2
    assert data["completed"] == 2
    assert data["remaining"] == 0
    # is_complete is True because all numbered tasks are done
    assert data["is_complete"] is True


# --- mode_read ---


def test_mode_read_returns_active_modes(mcp_server, working_dir, tmp_git_root):
    """mode_read returns active=True for modes that have state files."""
    state_dir = tmp_git_root / ".omca" / "state"

    _write_json(str(state_dir / RALPH_STATE_FILE), {"tasks": ["do something"]})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})

    result = call_tool(
        mcp_server,
        "mode_read",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["ralph"]["active"] is True
    assert data["ultrawork"]["active"] is True
    assert data["boulder"]["active"] is False
    assert data["evidence"]["active"] is False


def test_mode_read_empty_when_no_state(mcp_server, working_dir):
    """mode_read returns active=False for all modes when no state files exist."""
    result = call_tool(
        mcp_server,
        "mode_read",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["ralph"]["active"] is False
    assert data["ultrawork"]["active"] is False
    assert data["boulder"]["active"] is False
    assert data["evidence"]["active"] is False


# --- mode_clear ---


def test_mode_clear_all_removes_ralph_and_ultrawork(
    mcp_server, working_dir, tmp_git_root
):
    """mode_clear('all') removes ralph and ultrawork state files."""
    state_dir = tmp_git_root / ".omca" / "state"
    _write_json(str(state_dir / RALPH_STATE_FILE), {"tasks": ["work"]})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})

    result = call_tool(
        mcp_server,
        "mode_clear",
        {"mode": "all", "working_directory": working_dir},
    )
    assert "ralph" in result
    assert "ultrawork" in result
    assert not (state_dir / RALPH_STATE_FILE).exists()
    assert not (state_dir / ULTRAWORK_STATE_FILE).exists()


# --- boulder_progress with missing plan ---


def test_boulder_progress_missing_plan_returns_structured_error(
    mcp_server, working_dir, tmp_path
):
    """boulder_progress returns structured JSON error when plan file is deleted."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [ ] Task one\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "ghost-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    # Simulate platform deleting the plan file
    plan_file.unlink()

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["error"] is True
    assert data["plan_missing"] is True
    assert "plan.md" in data["plan_path"]


# --- mode_read with missing/valid plan ---


def test_mode_read_detects_stale_boulder_plan(
    mcp_server, working_dir, tmp_path, tmp_git_root
):
    """mode_read reports plan_exists=False when boulder points to deleted file."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [ ] Task\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "stale-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    plan_file.unlink()

    result = call_tool(
        mcp_server,
        "mode_read",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["boulder"]["active"] is True
    assert data["boulder"]["plan_exists"] is False


def test_mode_read_reports_plan_exists_true(
    mcp_server, working_dir, tmp_path, tmp_git_root
):
    """mode_read reports plan_exists=True when plan file exists."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [ ] Task\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "valid-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "mode_read",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["boulder"]["active"] is True
    assert data["boulder"]["plan_exists"] is True


# --- mode_clear ---


def test_mode_clear_ralph_only(mcp_server, working_dir, tmp_git_root):
    """mode_clear('ralph') removes only ralph state file, leaves ultrawork."""
    state_dir = tmp_git_root / ".omca" / "state"
    _write_json(str(state_dir / RALPH_STATE_FILE), {"tasks": ["work"]})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})

    result = call_tool(
        mcp_server,
        "mode_clear",
        {"mode": "ralph", "working_directory": working_dir},
    )
    assert "ralph" in result
    assert not (state_dir / RALPH_STATE_FILE).exists()
    assert (state_dir / ULTRAWORK_STATE_FILE).exists()


def test_mode_clear_final_verify(mcp_server, working_dir, tmp_git_root):
    """mode_clear('final_verify') removes pending-final-verify.json and reports it cleared."""
    state_dir = tmp_git_root / ".omca" / "state"
    marker_path = state_dir / PENDING_FINAL_VERIFY_FILE
    _write_json(
        str(marker_path),
        {
            "plan_path": "/tmp/fake",
            "plan_sha256": "deadbeef",
            "marked_at": 0,
            "session_id": "test",
        },
    )
    assert marker_path.exists()

    result = call_tool(
        mcp_server,
        "mode_clear",
        {"mode": "final_verify", "working_directory": working_dir},
    )

    assert "final_verify" in result
    assert "Cleared" in result
    assert not marker_path.exists()


def test_mode_clear_agents_truncates_active_preserves_completed(
    mcp_server, working_dir, tmp_git_root
):
    """mode_clear('agents') truncates subagents.json .active, preserves .completed, and
    removes active-agents.json — the operator escape hatch for wedged phantom agents."""
    state_dir = tmp_git_root / ".omca" / "state"
    _write_json(
        str(state_dir / "subagents.json"),
        {
            "active": [{"id": "phantom", "status": "running"}],
            "completed": [{"id": "done"}],
        },
    )
    _write_json(str(state_dir / "active-agents.json"), [{"id": "phantom"}])

    result = call_tool(
        mcp_server,
        "mode_clear",
        {"mode": "agents", "working_directory": working_dir},
    )

    assert "agents" in result
    sub = json.loads((state_dir / "subagents.json").read_text())
    assert sub["active"] == []
    assert sub["completed"] == [{"id": "done"}]
    assert not (state_dir / "active-agents.json").exists()


# --- boulder_write mirror ---


def test_boulder_write_mirrors_user_plan_to_project(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """Plan under ~/.claude/plans/ is mirrored to <project>/.omca/plans/."""
    fake_home = tmp_path / "home"
    user_plans = fake_home / ".claude" / "plans"
    user_plans.mkdir(parents=True)
    plan_file = user_plans / "foo.md"
    plan_file.write_text("# Plan foo\n- [ ] 1. Task one\n")
    src_sha = hashlib.sha256(plan_file.read_bytes()).hexdigest()

    with mock.patch("tools.boulder.Path") as mock_path_cls:
        # Patch Path.home() to return our fake home
        real_path = Path

        def path_side_effect(*args, **kwargs):
            return real_path(*args, **kwargs)

        mock_path_cls.side_effect = path_side_effect
        mock_path_cls.home.return_value = fake_home

        call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": str(plan_file),
                "plan_name": "foo",
                "session_id": "sess-001",
                "working_directory": working_dir,
            },
        )

    mirror = tmp_git_root / ".omca" / "plans" / "foo.md"
    assert mirror.exists(), "mirror file should be created under .omca/plans/"
    mirror_sha = hashlib.sha256(mirror.read_bytes()).hexdigest()
    assert mirror_sha == src_sha, "mirror SHA must match source SHA"


def test_boulder_write_mirrors_project_plan_to_user(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """Plan under .omca/plans/ is mirrored to ~/.claude/plans/."""
    project_plans = tmp_git_root / ".omca" / "plans"
    project_plans.mkdir(parents=True, exist_ok=True)
    plan_file = project_plans / "bar.md"
    plan_file.write_text("# Plan bar\n- [ ] 1. Task one\n")
    src_sha = hashlib.sha256(plan_file.read_bytes()).hexdigest()

    fake_home = tmp_path / "home"
    user_plans = fake_home / ".claude" / "plans"

    real_path = Path

    def path_side_effect(*args, **kwargs):
        return real_path(*args, **kwargs)

    with mock.patch("tools.boulder.Path") as mock_path_cls:
        mock_path_cls.side_effect = path_side_effect
        mock_path_cls.home.return_value = fake_home

        call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": str(plan_file),
                "plan_name": "bar",
                "session_id": "sess-001",
                "working_directory": working_dir,
            },
        )

    mirror = user_plans / "bar.md"
    assert mirror.exists(), "mirror file should be created under ~/.claude/plans/"
    mirror_sha = hashlib.sha256(mirror.read_bytes()).hexdigest()
    assert mirror_sha == src_sha, "mirror SHA must match source SHA"


def test_boulder_write_no_mirror_for_out_of_scheme_path(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """Plan at an arbitrary path outside known schemes produces no mirror and no warning."""
    plan_file = tmp_path / "random" / "place.md"
    plan_file.parent.mkdir(parents=True)
    plan_file.write_text("# Random plan\n- [ ] 1. Task one\n")

    import io

    captured = io.StringIO()
    with mock.patch("sys.stderr", captured):
        call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": str(plan_file),
                "plan_name": "random-plan",
                "session_id": "sess-001",
                "working_directory": working_dir,
            },
        )

    # No mirror directories should be created
    assert not (tmp_git_root / ".omca" / "plans").exists() or not any(
        (tmp_git_root / ".omca" / "plans").iterdir()
        if (tmp_git_root / ".omca" / "plans").exists()
        else []
    )
    # No warning emitted for out-of-scheme paths
    assert "WARN" not in captured.getvalue()


def test_boulder_write_source_unreadable_returns_success_with_warning(
    mcp_server, working_dir, tmp_git_root, tmp_path, capsys
):
    """If source plan is unreadable, boulder_write succeeds and emits a single stderr warning."""
    fake_home = tmp_path / "home"
    user_plans = fake_home / ".claude" / "plans"
    user_plans.mkdir(parents=True)
    # Use a path that doesn't exist so read fails
    nonexistent_plan = user_plans / "ghost.md"

    real_path = Path

    def path_side_effect(*args, **kwargs):
        return real_path(*args, **kwargs)

    with mock.patch("tools.boulder.Path") as mock_path_cls:
        mock_path_cls.side_effect = path_side_effect
        mock_path_cls.home.return_value = fake_home

        result = call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": str(nonexistent_plan),
                "plan_name": "ghost",
                "session_id": "sess-001",
                "working_directory": working_dir,
            },
        )

    # boulder_write must succeed (return a success message, not raise)
    assert "ghost" in result
    assert "sessions=1" in result
    # Warning goes to stderr
    captured = capsys.readouterr()
    assert "WARN: boulder_write: could not read plan source for mirror" in captured.err


def test_boulder_write_normalizes_legacy_state(mcp_server, working_dir, tmp_git_root):
    """Legacy top-level boulder state is normalized to schema v2 on write."""
    state_dir = tmp_git_root / ".omca" / "state"
    _write_json(
        str(state_dir / BOULDER_FILE),
        {
            "active_plan": "/tmp/legacy-plan.md",
            "plan_name": "legacy-plan",
            "session_ids": ["sess-old"],
            "agent": "sisyphus",
            "started_at": "2026-05-13T00:00:00Z",
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/legacy-plan.md",
            "plan_name": "legacy-plan",
            "session_id": "sess-new",
            "working_directory": working_dir,
        },
    )
    assert "sessions=2" in result

    data = json.loads((state_dir / BOULDER_FILE).read_text())
    assert data["schema_version"] == 2
    assert data["active_work_id"] in data["works"]
    work = data["works"][data["active_work_id"]]
    assert work["started_at"] == "2026-05-13T00:00:00Z"
    assert work["session_ids"] == ["sess-old", "sess-new"]
    assert data["active_plan"] == work["active_plan"]


def test_boulder_multi_work_list_select_complete(
    mcp_server, working_dir, tmp_path, tmp_git_root
):
    """Multiple works can be listed, selected, and completed independently."""
    plan_one = tmp_path / "one.md"
    plan_two = tmp_path / "two.md"
    plan_one.write_text("- [ ] 1. One\n")
    plan_two.write_text("- [x] 1. Two\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_one),
            "plan_name": "one",
            "session_id": "s1",
            "working_directory": working_dir,
        },
    )
    first_state = json.loads(
        (tmp_git_root / ".omca" / "state" / BOULDER_FILE).read_text()
    )
    first_id = first_state["active_work_id"]
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_two),
            "plan_name": "two",
            "session_id": "s2",
            "working_directory": working_dir,
        },
    )
    second_state = json.loads(
        (tmp_git_root / ".omca" / "state" / BOULDER_FILE).read_text()
    )
    second_id = second_state["active_work_id"]

    listed = json.loads(
        call_tool(mcp_server, "boulder_list", {"working_directory": working_dir})
    )
    assert listed["active_work_id"] == second_id
    assert listed["counts"]["resumeable"] == 2
    assert {item["work_id"] for item in listed["resume_options"]} == {
        first_id,
        second_id,
    }

    selected = json.loads(
        call_tool(
            mcp_server,
            "boulder_select",
            {"work_id": first_id, "working_directory": working_dir},
        )
    )
    assert selected["active_work_id"] == first_id

    completed = json.loads(
        call_tool(mcp_server, "boulder_complete", {"working_directory": working_dir})
    )
    assert completed["completed_work_id"] == first_id
    assert completed["active_work_id"] == second_id

    listed_after = json.loads(
        call_tool(mcp_server, "boulder_list", {"working_directory": working_dir})
    )
    assert listed_after["counts"]["completed"] == 1
    assert {item["work_id"] for item in listed_after["resume_options"]} == {second_id}


def test_boulder_task_timers_and_reserved_keys(
    mcp_server, working_dir, tmp_path, tmp_git_root
):
    """Task start/end records elapsed timers and rejects reserved object keys."""
    plan = tmp_path / "plan.md"
    plan.write_text("- [ ] 1. Task\n")
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan),
            "plan_name": "tasks",
            "session_id": "s1",
            "working_directory": working_dir,
        },
    )

    started = json.loads(
        call_tool(
            mcp_server,
            "boulder_task_start",
            {
                "task_key": "task-1",
                "task_label": "T1",
                "task_title": "Do task",
                "session_id": "s-task",
                "agent": "executor",
                "category": "build",
                "working_directory": working_dir,
            },
        )
    )
    assert started["started"] is True
    ended = json.loads(
        call_tool(
            mcp_server,
            "boulder_task_end",
            {"task_key": "task-1", "working_directory": working_dir},
        )
    )
    assert ended["completed"] is True
    assert ended["elapsed_ms"] >= 0

    data = json.loads((tmp_git_root / ".omca" / "state" / BOULDER_FILE).read_text())
    task = data["works"][data["active_work_id"]]["task_sessions"]["task-1"]
    assert task["status"] == "completed"
    assert task["started_at"]
    rejected = json.loads(
        call_tool(
            mcp_server,
            "boulder_task_start",
            {
                "task_key": "__proto__",
                "task_label": "bad",
                "task_title": "bad",
                "session_id": "s-task",
                "working_directory": working_dir,
            },
        )
    )
    assert rejected["error"] is True
    assert "reserved" in rejected["message"]


def test_boulder_progress_structured_sections_ignore_nested(
    mcp_server, working_dir, tmp_path
):
    """Structured TODO/final-wave parsing counts only top-level task rows."""
    plan = tmp_path / "structured.md"
    plan.write_text(
        "# Plan\n\n"
        "## TODOs\n\n"
        "- [x] 1. Done\n"
        "  - [ ] nested unchecked\n"
        "- [ ] 2. Pending\n\n"
        "## Final Verification Wave\n\n"
        "- [ ] F1. Review\n"
        "  - [x] nested checked\n"
        "- [x] F2. Validate\n\n"
        "## Other\n"
        "- [ ] 99. Not counted\n"
    )
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan),
            "plan_name": "structured",
            "session_id": "s1",
            "working_directory": working_dir,
        },
    )

    data = json.loads(
        call_tool(mcp_server, "boulder_progress", {"working_directory": working_dir})
    )
    assert data["total"] == 4
    assert data["completed"] == 2
    assert data["remaining"] == 2
    assert data["current_task"] == "2. Pending"


def test_boulder_progress_prefers_worktree_plan_path(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """When active_plan is inside the repo, worktree_path resolves to the worktree copy."""
    repo_plan_dir = tmp_git_root / "plans"
    repo_plan_dir.mkdir()
    repo_plan = repo_plan_dir / "plan.md"
    repo_plan.write_text("- [ ] 1. Repo pending\n")
    worktree = tmp_path / "worktree"
    worktree_plan_dir = worktree / "plans"
    worktree_plan_dir.mkdir(parents=True)
    worktree_plan = worktree_plan_dir / "plan.md"
    worktree_plan.write_text("- [x] 1. Worktree done\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(repo_plan),
            "plan_name": "worktree-plan",
            "session_id": "s1",
            "worktree_path": str(worktree),
            "working_directory": working_dir,
        },
    )

    data = json.loads(
        call_tool(mcp_server, "boulder_progress", {"working_directory": working_dir})
    )
    assert data["plan_path"] == str(worktree_plan)
    assert data["is_complete"] is True


def test_boulder_write_mirror_idempotent(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """Second boulder_write call with same plan content skips mirror I/O (idempotent)."""
    fake_home = tmp_path / "home"
    user_plans = fake_home / ".claude" / "plans"
    user_plans.mkdir(parents=True)
    plan_file = user_plans / "idem.md"
    plan_file.write_text("# Idempotent plan\n- [ ] 1. Task\n")

    real_path = Path

    def path_side_effect(*args, **kwargs):
        return real_path(*args, **kwargs)

    def call():
        with mock.patch("tools.boulder.Path") as mock_path_cls:
            mock_path_cls.side_effect = path_side_effect
            mock_path_cls.home.return_value = fake_home
            call_tool(
                mcp_server,
                "boulder_write",
                {
                    "active_plan": str(plan_file),
                    "plan_name": "idem",
                    "session_id": "sess-001",
                    "working_directory": working_dir,
                },
            )

    call()
    mirror = tmp_git_root / ".omca" / "plans" / "idem.md"
    assert mirror.exists()
    mtime_first = mirror.stat().st_mtime

    call()
    mtime_second = mirror.stat().st_mtime
    # mtime should be unchanged — no write occurred
    assert mtime_first == mtime_second


# --- session_id env-default ---


def test_boulder_write_session_id_from_env(mcp_server, working_dir, tmp_git_root):
    """boulder_write uses CLAUDE_CODE_SESSION_ID env var when session_id param is empty."""
    with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "env-sess-001"}):
        result = call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": "/tmp/plan.md",
                "plan_name": "env-plan",
                "session_id": "",
                "working_directory": working_dir,
            },
        )
    assert "env-plan" in result
    assert "sessions=1" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    work = data["works"][data["active_work_id"]]
    assert work["session_ids"] == ["env-sess-001"]


def test_boulder_write_explicit_session_id_wins_over_env(
    mcp_server, working_dir, tmp_git_root
):
    """boulder_write uses explicit session_id param over CLAUDE_CODE_SESSION_ID env var."""
    with mock.patch.dict(
        os.environ, {"CLAUDE_CODE_SESSION_ID": "env-sess-should-lose"}
    ):
        result = call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": "/tmp/plan.md",
                "plan_name": "param-wins-plan",
                "session_id": "explicit-sess-001",
                "working_directory": working_dir,
            },
        )
    assert "sessions=1" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    work = data["works"][data["active_work_id"]]
    assert work["session_ids"] == ["explicit-sess-001"]


def test_boulder_write_neither_session_id_nor_env(
    mcp_server, working_dir, tmp_git_root
):
    """boulder_write with empty session_id and no env var preserves empty behavior."""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_SESSION_ID"}
    with mock.patch.dict(os.environ, env, clear=True):
        result = call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": "/tmp/plan.md",
                "plan_name": "no-session-plan",
                "session_id": "",
                "working_directory": working_dir,
            },
        )
    assert "no-session-plan" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    work = data["works"][data["active_work_id"]]
    assert work["session_ids"] == []


def test_boulder_task_start_session_id_from_env(
    mcp_server, working_dir, tmp_path, tmp_git_root
):
    """boulder_task_start uses CLAUDE_CODE_SESSION_ID env var when session_id param is empty."""
    plan = tmp_path / "plan.md"
    plan.write_text("- [ ] 1. Task\n")
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan),
            "plan_name": "tasks-env",
            "session_id": "s1",
            "working_directory": working_dir,
        },
    )

    with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "env-task-sess"}):
        result = json.loads(
            call_tool(
                mcp_server,
                "boulder_task_start",
                {
                    "task_key": "task-env",
                    "task_label": "T-env",
                    "task_title": "Env task",
                    "session_id": "",
                    "working_directory": working_dir,
                },
            )
        )
    assert result["started"] is True

    data = json.loads((tmp_git_root / ".omca" / "state" / BOULDER_FILE).read_text())
    task = data["works"][data["active_work_id"]]["task_sessions"]["task-env"]
    assert task["session_id"] == "env-task-sess"


def test_boulder_task_start_explicit_session_id_wins_over_env(
    mcp_server, working_dir, tmp_path, tmp_git_root
):
    """boulder_task_start uses explicit session_id over CLAUDE_CODE_SESSION_ID env var."""
    plan = tmp_path / "plan.md"
    plan.write_text("- [ ] 1. Task\n")
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan),
            "plan_name": "tasks-param-wins",
            "session_id": "s1",
            "working_directory": working_dir,
        },
    )

    with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "env-should-lose"}):
        result = json.loads(
            call_tool(
                mcp_server,
                "boulder_task_start",
                {
                    "task_key": "task-param",
                    "task_label": "T-param",
                    "task_title": "Param task",
                    "session_id": "explicit-task-sess",
                    "working_directory": working_dir,
                },
            )
        )
    assert result["started"] is True

    data = json.loads((tmp_git_root / ".omca" / "state" / BOULDER_FILE).read_text())
    task = data["works"][data["active_work_id"]]["task_sessions"]["task-param"]
    assert task["session_id"] == "explicit-task-sess"


def test_boulder_task_start_neither_session_id_nor_env(
    mcp_server, working_dir, tmp_path, tmp_git_root
):
    """boulder_task_start with empty session_id and no env var records empty session_id."""
    plan = tmp_path / "plan.md"
    plan.write_text("- [ ] 1. Task\n")
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan),
            "plan_name": "tasks-no-sess",
            "session_id": "s1",
            "working_directory": working_dir,
        },
    )

    env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_SESSION_ID"}
    with mock.patch.dict(os.environ, env, clear=True):
        result = json.loads(
            call_tool(
                mcp_server,
                "boulder_task_start",
                {
                    "task_key": "task-no-sess",
                    "task_label": "T-nosess",
                    "task_title": "No sess task",
                    "session_id": "",
                    "working_directory": working_dir,
                },
            )
        )
    assert result["started"] is True

    data = json.loads((tmp_git_root / ".omca" / "state" / BOULDER_FILE).read_text())
    task = data["works"][data["active_work_id"]]["task_sessions"]["task-no-sess"]
    assert task["session_id"] == ""
