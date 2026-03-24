"""Tests for boulder and mode MCP tools."""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import boulder as boulder_module
from tools._common import (
    BOULDER_FILE,
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
        "# My Plan\n\n- [x] Task one done\n- [ ] Task two pending\n- [ ] Task three pending\n"
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
