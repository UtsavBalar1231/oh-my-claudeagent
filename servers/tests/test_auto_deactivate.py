"""Tests for _maybe_auto_deactivate / boulder_progress auto-deactivation (T15/T16)."""

import asyncio
import hashlib
import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import boulder as boulder_module
from tools._common import (
    BOULDER_FILE,
    EVIDENCE_FILE,
    PENDING_FINAL_VERIFY_FILE,
    RALPH_STATE_FILE,
    ULTRAWORK_STATE_FILE,
    _write_json,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def call_tool(server: FastMCP, name: str, args: dict) -> str:
    """Call an MCP tool synchronously and return the text result."""
    result = asyncio.run(server.call_tool(name, args))
    return result[1]["result"]


def _make_plan_content(all_done: bool = True) -> str:
    """Return minimal plan content with all tasks done or one pending."""
    if all_done:
        return "# Plan\n\n- [x] 1. Task one\n- [x] 2. Task two\n"
    return "# Plan\n\n- [x] 1. Task one\n- [ ] 2. Task two\n"


def _plan_sha(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mcp_server():
    """Create a FastMCP server with boulder tools registered."""
    server = FastMCP("test-auto-deactivate")
    boulder_module.register(server)
    return server


@pytest.fixture
def synthetic_state_dir(tmp_path, tmp_git_root, working_dir):
    """
    Isolated state dir fixture for auto-deactivation tests.

    - tmp_path / tmp_git_root provide a real git repo root with .omca/state/
    - Writes a synthetic boulder.json and verification-evidence.json
    - Yields (state_dir_path, plan_file_path, plan_sha) tuple
    - All state is inside tmp_git_root; real state dirs are never touched
    """
    state_dir = tmp_git_root / ".omca" / "state"

    plan_content = _make_plan_content(all_done=True)
    plan_file = tmp_path / "test-plan.md"
    plan_file.write_text(plan_content)
    sha = _plan_sha(plan_content)

    # Write active boulder.json
    _write_json(
        str(state_dir / BOULDER_FILE),
        {
            "active_plan": str(plan_file),
            "plan_name": "test-plan",
            "session_ids": ["sess-001"],
            "agent": "sisyphus",
            "started_at": "2026-05-13T00:00:00Z",
        },
    )

    # Write placeholder mode files so we can check they are cleared
    _write_json(str(state_dir / RALPH_STATE_FILE), {"task": "do work"})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})
    _write_json(
        str(state_dir / PENDING_FINAL_VERIFY_FILE),
        {"plan_sha256": sha, "plan_path": str(plan_file)},
    )

    yield state_dir, plan_file, sha


# ---------------------------------------------------------------------------
# Test 1: plan complete + F4 APPROVE with matching SHA -> auto_deactivated=True
# ---------------------------------------------------------------------------


def test_auto_deactivate_f4_approve_matching_sha(
    mcp_server, working_dir, tmp_git_root, synthetic_state_dir, tmp_path
):
    """Plan complete + F4 APPROVE with matching SHA triggers auto-deactivation."""
    state_dir, _plan_file, sha = synthetic_state_dir

    # Write evidence with a matching F4 APPROVE entry
    _write_json(
        str(state_dir / EVIDENCE_FILE),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": sha,
                    "exit_code": 0,
                    "output_snippet": "All checks passed",
                    "command": "final check",
                }
            ]
        },
    )

    result_str = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result_str)

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is True
    assert set(data["cleared"]) == {"ralph", "ultrawork", "boulder", "final_verify"}

    # Mode files must be removed
    assert not (state_dir / RALPH_STATE_FILE).exists()
    assert not (state_dir / ULTRAWORK_STATE_FILE).exists()
    assert not (state_dir / BOULDER_FILE).exists()
    assert not (state_dir / PENDING_FINAL_VERIFY_FILE).exists()

    # Evidence file MUST still exist (never auto-cleared)
    assert (state_dir / EVIDENCE_FILE).exists()


# ---------------------------------------------------------------------------
# Test 2: plan complete + F4 APPROVE with DIFFERENT SHA -> no auto-deactivation
# ---------------------------------------------------------------------------


def test_auto_deactivate_f4_approve_wrong_sha(
    mcp_server, working_dir, tmp_git_root, synthetic_state_dir
):
    """Plan complete + F4 APPROVE with different SHA -> auto_deactivated=False."""
    state_dir, _plan_file, _sha = synthetic_state_dir

    wrong_sha = "a" * 64  # 64-char hex, guaranteed different from real sha
    _write_json(
        str(state_dir / EVIDENCE_FILE),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": wrong_sha,
                    "exit_code": 0,
                    "output_snippet": "APPROVE",
                    "command": "final check",
                }
            ]
        },
    )

    result_str = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result_str)

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is False
    assert data["reason"] == "no_matching_f4_approve"

    # Mode files must NOT have been removed
    assert (state_dir / RALPH_STATE_FILE).exists()
    assert (state_dir / ULTRAWORK_STATE_FILE).exists()
    assert (state_dir / BOULDER_FILE).exists()


# ---------------------------------------------------------------------------
# Test 3: plan complete + only F1/F2/F3 entries -> no auto-deactivation
# ---------------------------------------------------------------------------


def test_auto_deactivate_no_f4_only_earlier_waves(
    mcp_server, working_dir, tmp_git_root, synthetic_state_dir
):
    """Plan complete + only F1/F2/F3 APPROVE entries -> auto_deactivated=False."""
    state_dir, _plan_file, sha = synthetic_state_dir

    _write_json(
        str(state_dir / EVIDENCE_FILE),
        {
            "entries": [
                {
                    "type": "final_verification_f1",
                    "plan_sha256": sha,
                    "exit_code": 0,
                    "output_snippet": "APPROVE",
                    "command": "f1 check",
                },
                {
                    "type": "final_verification_f2",
                    "plan_sha256": sha,
                    "exit_code": 0,
                    "output_snippet": "APPROVE",
                    "command": "f2 check",
                },
                {
                    "type": "final_verification_f3",
                    "plan_sha256": sha,
                    "exit_code": 0,
                    "output_snippet": "APPROVE",
                    "command": "f3 check",
                },
            ]
        },
    )

    result_str = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result_str)

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is False
    assert data["reason"] == "no_matching_f4_approve"


# ---------------------------------------------------------------------------
# Test 4: plan incomplete -> _load_evidence is NOT called
# ---------------------------------------------------------------------------


def test_auto_deactivate_skipped_when_plan_incomplete(
    mcp_server, working_dir, tmp_git_root, tmp_path, monkeypatch
):
    """When plan is incomplete, _maybe_auto_deactivate is never entered."""
    import tools._common as common_module

    # Incomplete plan
    plan_content = _make_plan_content(all_done=False)
    plan_file = tmp_path / "incomplete-plan.md"
    plan_file.write_text(plan_content)

    state_dir = tmp_git_root / ".omca" / "state"
    _write_json(
        str(state_dir / BOULDER_FILE),
        {
            "active_plan": str(plan_file),
            "plan_name": "incomplete-plan",
            "session_ids": ["sess-001"],
            "agent": "sisyphus",
            "started_at": "2026-05-13T00:00:00Z",
        },
    )

    mock_load = MagicMock(return_value=[])
    monkeypatch.setattr(common_module, "_load_evidence", mock_load)
    # Also patch the reference inside boulder module
    monkeypatch.setattr(boulder_module, "_load_evidence", mock_load)

    result_str = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result_str)

    assert data["is_complete"] is False
    assert mock_load.called is False, (
        "_load_evidence should NOT be called for incomplete plans"
    )


# ---------------------------------------------------------------------------
# Test 5: _load_evidence raises -> fail-safe: auto_deactivated=False, no raise
# ---------------------------------------------------------------------------


def test_auto_deactivate_fail_safe_on_evidence_read_error(
    mcp_server, working_dir, tmp_git_root, synthetic_state_dir, monkeypatch
):
    """When _load_evidence raises, boulder_progress returns fail-safe response without raising."""
    state_dir, _plan_file, _sha = synthetic_state_dir

    def _exploding_load_evidence(sd):
        raise RuntimeError("simulated read failure")

    monkeypatch.setattr(boulder_module, "_load_evidence", _exploding_load_evidence)

    # boulder_progress must NOT raise
    result_str = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    data = json.loads(result_str)

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is False
    assert data["reason"] == "evidence_read_failed"

    # Mode files must NOT have been removed (fail-safe: no partial clear)
    assert (state_dir / RALPH_STATE_FILE).exists()
    assert (state_dir / ULTRAWORK_STATE_FILE).exists()
    assert (state_dir / BOULDER_FILE).exists()
