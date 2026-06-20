"""Tests for flat boulder MCP tools (boulder_write and boulder_progress)."""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import boulder as boulder_module
from tools._common import BOULDER_FILE


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


# --- boulder_write: single-object write ---


def test_boulder_write_creates_flat_state_file(mcp_server, working_dir, tmp_git_root):
    """boulder_write creates a flat boulder.json with the correct top-level keys."""
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
    # Flat schema: active_plan must be a top-level key (statusline reads it here)
    assert data["active_plan"] == "/tmp/plan.md"
    assert data["plan_name"] == "my-plan"
    assert data["session_ids"] == ["sess-001"]
    assert "started_at" in data
    assert "agent" in data
    # No multi-work schema keys
    assert "works" not in data
    assert "schema_version" not in data
    assert "active_work_id" not in data


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


def test_boulder_write_deduplicates_sessions(mcp_server, working_dir, tmp_git_root):
    """Calling boulder_write twice with the same session_id does not duplicate it."""
    for _ in range(2):
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
    data = json.loads(path.read_text())
    assert data["session_ids"].count("sess-001") == 1


def test_boulder_write_preserves_started_at(mcp_server, working_dir, tmp_git_root):
    """Second boulder_write call preserves the original started_at timestamp."""
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


def test_boulder_write_session_id_from_env(mcp_server, working_dir, tmp_git_root):
    """boulder_write uses CLAUDE_CODE_SESSION_ID env var when session_id param is empty."""
    import unittest.mock as mock

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
    assert data["session_ids"] == ["env-sess-001"]


# --- boulder_progress: checkbox counting ---


def test_boulder_progress_reads_plan_checkboxes(mcp_server, working_dir, tmp_path):
    """boulder_progress parses plan file checkboxes and returns task counts."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(
        "# My Plan\n\n- [x] 1. Task one done\n- [ ] 2. Task two pending\n- [ ] 3. Task three pending\n"
    )

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


def test_boulder_progress_exact_regex_unnumbered_ignored(
    mcp_server, working_dir, tmp_path
):
    """boulder_progress counts only lines matching ^- \\[([ x])\\] \\d+\\. (numbered checkboxes)."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(
        "# Plan\n\n"
        "- [x] 1. Numbered done\n"
        "- [ ] 2. Numbered pending\n"
        "- [x] Review docs\n"  # unnumbered — must NOT be counted
        "- [ ] Notify stakeholders\n"  # unnumbered — must NOT be counted
    )

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "regex-plan",
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
    # Only the 2 numbered tasks count
    assert data["total"] == 2
    assert data["completed"] == 1
    assert data["remaining"] == 1


def test_boulder_progress_all_complete(mcp_server, working_dir, tmp_path):
    """boulder_progress reports is_complete=True when all numbered checkboxes are checked."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [x] 1. Task one done\n- [x] 2. Task two done\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "done-plan",
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
    assert data["total"] == 2
    assert data["completed"] == 2
    assert data["remaining"] == 0
    assert data["is_complete"] is True


def test_boulder_progress_empty_plan(mcp_server, working_dir, tmp_path):
    """boulder_progress on a plan with no numbered checkboxes returns total=0, is_complete=False."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Empty plan\n\nNo tasks here.\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "empty-plan",
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
    assert data["total"] == 0
    assert data["is_complete"] is False


def test_boulder_progress_explicit_plan_path(mcp_server, working_dir, tmp_path):
    """boulder_progress accepts an explicit plan_path without requiring boulder state."""
    plan_file = tmp_path / "standalone.md"
    plan_file.write_text("- [x] 1. Done\n- [ ] 2. Pending\n")

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"plan_path": str(plan_file), "working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["total"] == 2
    assert data["completed"] == 1
    assert data["plan_path"] == str(plan_file)


def test_boulder_progress_missing_plan_returns_structured_error(
    mcp_server, working_dir, tmp_path
):
    """boulder_progress returns structured JSON error when plan file is deleted."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [ ] 1. Task one\n")

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


def test_boulder_progress_no_active_plan_returns_message(mcp_server, working_dir):
    """boulder_progress with no boulder state returns a plain-string message."""
    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    assert "No active plan" in result
