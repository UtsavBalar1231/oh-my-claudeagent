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
    EVIDENCE_DIR,
    EVIDENCE_FILE_NEW,
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

    # Write evidence with a matching F4 APPROVE entry to the canonical path
    evidence_path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    _write_json(
        str(evidence_path),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": sha,
                    "exit_code": 0,
                    "verdict": "APPROVE",
                    "output_snippet": "verdict:APPROVE — all checks passed",
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
    assert evidence_path.exists()


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
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW),
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
    _state_dir, _plan_file, sha = synthetic_state_dir

    _write_json(
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW),
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


def test_auto_deactivate_requires_explicit_f4_approve(
    mcp_server, working_dir, tmp_git_root, synthetic_state_dir
):
    """Exit code 0 without an APPROVE verdict is not enough to auto-deactivate."""
    state_dir, _plan_file, sha = synthetic_state_dir
    evidence_path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    _write_json(
        str(evidence_path),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": sha,
                    "exit_code": 0,
                    "output_snippet": "REJECT — issue found",
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
    assert (state_dir / BOULDER_FILE).exists()


@pytest.mark.parametrize(
    "entry_updates",
    [
        {"verdict": "DISAPPROVE", "output_snippet": "verdict:DISAPPROVE"},
        {"output_snippet": "NOT APPROVED"},
        {"exit_code": 1, "verdict": "APPROVE", "output_snippet": "verdict:APPROVE"},
        {
            "type": "final_verification_f4_retry",
            "verdict": "APPROVE",
            "output_snippet": "verdict:APPROVE",
        },
    ],
)
def test_auto_deactivate_rejects_non_strict_f4_approval(
    mcp_server, working_dir, tmp_git_root, synthetic_state_dir, entry_updates
):
    """Only exact F4, exit 0, explicit APPROVE verdict can auto-deactivate."""
    state_dir, _plan_file, sha = synthetic_state_dir
    entry = {
        "type": "final_verification_f4",
        "plan_sha256": sha,
        "exit_code": 0,
        "output_snippet": "verdict:APPROVE",
        "command": "final check",
    }
    entry.update(entry_updates)
    _write_json(
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW), {"entries": [entry]}
    )

    data = json.loads(
        call_tool(mcp_server, "boulder_progress", {"working_directory": working_dir})
    )

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is False
    assert data["reason"] == "no_matching_f4_approve"
    assert (state_dir / BOULDER_FILE).exists()
    assert (state_dir / RALPH_STATE_FILE).exists()
    assert (state_dir / ULTRAWORK_STATE_FILE).exists()


@pytest.mark.parametrize(
    "entry_updates",
    [
        {"verdict": "APPROVE", "output_snippet": "final check passed"},
        {"output_snippet": "all checks passed verdict:APPROVE"},
    ],
)
def test_auto_deactivate_accepts_explicit_f4_approve_verdicts(
    mcp_server, working_dir, tmp_git_root, synthetic_state_dir, entry_updates
):
    """Explicit verdict field or verdict:APPROVE snippet is accepted."""
    state_dir, _plan_file, sha = synthetic_state_dir
    entry = {
        "type": "final_verification_f4",
        "plan_sha256": sha,
        "exit_code": 0,
        "command": "final check",
    }
    entry.update(entry_updates)
    _write_json(
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW), {"entries": [entry]}
    )

    data = json.loads(
        call_tool(mcp_server, "boulder_progress", {"working_directory": working_dir})
    )

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is True
    assert not (state_dir / BOULDER_FILE).exists()


def test_boulder_progress_explicit_plan_path_without_work_id_does_not_deactivate_active_work(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """A complete explicit plan_path must not auto-complete unrelated active work."""
    state_dir = tmp_git_root / ".omca" / "state"
    active_plan = tmp_path / "active.md"
    active_plan.write_text(_make_plan_content(all_done=False))
    complete_content = _make_plan_content(all_done=True)
    complete_plan = tmp_path / "complete-explicit.md"
    complete_plan.write_text(complete_content)

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(active_plan),
            "plan_name": "active-work",
            "session_id": "sess-active",
            "working_directory": working_dir,
        },
    )
    active_id = json.loads((state_dir / BOULDER_FILE).read_text())["active_work_id"]
    _write_json(str(state_dir / RALPH_STATE_FILE), {"task": "do work"})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})
    _write_json(
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": _plan_sha(complete_content),
                    "exit_code": 0,
                    "verdict": "APPROVE",
                    "output_snippet": "verdict:APPROVE",
                    "command": "final check",
                }
            ]
        },
    )

    data = json.loads(
        call_tool(
            mcp_server,
            "boulder_progress",
            {"plan_path": str(complete_plan), "working_directory": working_dir},
        )
    )

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is False
    assert data["reason"] == "explicit_plan_without_work_id"
    retained = json.loads((state_dir / BOULDER_FILE).read_text())
    assert retained["active_work_id"] == active_id
    assert retained["works"][active_id]["status"] == "active"
    assert (state_dir / RALPH_STATE_FILE).exists()
    assert (state_dir / ULTRAWORK_STATE_FILE).exists()


def test_explicit_plan_path_unknown_work_id_does_not_deactivate_single_active_work(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """Unknown explicit work_id must not fall back to the only active work."""
    state_dir = tmp_git_root / ".omca" / "state"
    active_plan = tmp_path / "active-incomplete.md"
    active_plan.write_text(_make_plan_content(all_done=False))
    complete_content = _make_plan_content(all_done=True)
    complete_plan = tmp_path / "complete-unknown-work.md"
    complete_plan.write_text(complete_content)

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(active_plan),
            "plan_name": "active-single",
            "session_id": "sess-active",
            "working_directory": working_dir,
        },
    )
    active_id = json.loads((state_dir / BOULDER_FILE).read_text())["active_work_id"]
    _write_json(str(state_dir / RALPH_STATE_FILE), {"task": "do work"})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})
    _write_json(
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": _plan_sha(complete_content),
                    "exit_code": 0,
                    "verdict": "APPROVE",
                    "command": "final check",
                }
            ]
        },
    )

    data = json.loads(
        call_tool(
            mcp_server,
            "boulder_progress",
            {
                "plan_path": str(complete_plan),
                "work_id": "missing-work",
                "working_directory": working_dir,
            },
        )
    )

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is False
    assert data["reason"] == "work_not_found"
    retained = json.loads((state_dir / BOULDER_FILE).read_text())
    assert retained["active_work_id"] == active_id
    assert retained["works"][active_id]["status"] == "active"
    assert (state_dir / RALPH_STATE_FILE).exists()
    assert (state_dir / ULTRAWORK_STATE_FILE).exists()


def test_explicit_plan_path_mismatched_work_id_does_not_deactivate_work(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """Explicit plan_path must belong to the requested work_id before deactivation."""
    state_dir = tmp_git_root / ".omca" / "state"
    work_plan = tmp_path / "requested-work.md"
    work_plan.write_text(_make_plan_content(all_done=False))
    complete_content = _make_plan_content(all_done=True)
    other_plan = tmp_path / "other-complete.md"
    other_plan.write_text(complete_content)

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(work_plan),
            "plan_name": "requested-work",
            "session_id": "sess-work",
            "working_directory": working_dir,
        },
    )
    work_id = json.loads((state_dir / BOULDER_FILE).read_text())["active_work_id"]
    _write_json(str(state_dir / RALPH_STATE_FILE), {"task": "do work"})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})
    _write_json(
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": _plan_sha(complete_content),
                    "exit_code": 0,
                    "verdict": "APPROVE",
                    "command": "final check",
                }
            ]
        },
    )

    data = json.loads(
        call_tool(
            mcp_server,
            "boulder_progress",
            {
                "plan_path": str(other_plan),
                "work_id": work_id,
                "working_directory": working_dir,
            },
        )
    )

    assert data["is_complete"] is True
    assert data["auto_deactivated"] is False
    assert data["reason"] == "plan_path_work_mismatch"
    retained = json.loads((state_dir / BOULDER_FILE).read_text())
    assert retained["works"][work_id]["status"] == "active"
    assert (state_dir / RALPH_STATE_FILE).exists()
    assert (state_dir / ULTRAWORK_STATE_FILE).exists()


def test_explicit_matching_plan_path_and_work_id_can_deactivate(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """Explicit plan_path + matching work_id is allowed to auto-deactivate."""
    state_dir = tmp_git_root / ".omca" / "state"
    complete_content = _make_plan_content(all_done=True)
    complete_plan = tmp_path / "matching-complete.md"
    complete_plan.write_text(complete_content)

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(complete_plan),
            "plan_name": "matching-work",
            "session_id": "sess-work",
            "working_directory": working_dir,
        },
    )
    work_id = json.loads((state_dir / BOULDER_FILE).read_text())["active_work_id"]
    _write_json(str(state_dir / RALPH_STATE_FILE), {"task": "do work"})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})
    _write_json(
        str(tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": _plan_sha(complete_content),
                    "exit_code": 0,
                    "verdict": "APPROVE",
                    "command": "final check",
                }
            ]
        },
    )

    data = json.loads(
        call_tool(
            mcp_server,
            "boulder_progress",
            {
                "plan_path": str(complete_plan),
                "work_id": work_id,
                "working_directory": working_dir,
            },
        )
    )

    assert data["auto_deactivated"] is True
    assert data["completed_work_id"] == work_id
    assert not (state_dir / BOULDER_FILE).exists()


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


def test_auto_deactivate_completes_current_work_only_when_others_active(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """F4 approve completes only current work and retains boulder when another work is active."""
    state_dir = tmp_git_root / ".omca" / "state"
    done_content = _make_plan_content(all_done=True)
    done_plan = tmp_path / "done.md"
    done_plan.write_text(done_content)
    other_plan = tmp_path / "other.md"
    other_plan.write_text(_make_plan_content(all_done=False))
    done_sha = _plan_sha(done_content)

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(other_plan),
            "plan_name": "other",
            "session_id": "sess-other",
            "working_directory": working_dir,
        },
    )
    other_state = json.loads((state_dir / BOULDER_FILE).read_text())
    other_id = other_state["active_work_id"]
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(done_plan),
            "plan_name": "done",
            "session_id": "sess-done",
            "working_directory": working_dir,
        },
    )
    done_state = json.loads((state_dir / BOULDER_FILE).read_text())
    done_id = done_state["active_work_id"]

    _write_json(str(state_dir / RALPH_STATE_FILE), {"task": "do work"})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})
    _write_json(
        str(state_dir / PENDING_FINAL_VERIFY_FILE),
        {"plan_sha256": done_sha, "plan_path": str(done_plan)},
    )
    evidence_path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    _write_json(
        str(evidence_path),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": done_sha,
                    "exit_code": 0,
                    "output_snippet": "verdict:APPROVE",
                    "command": "final check",
                }
            ]
        },
    )

    data = json.loads(
        call_tool(mcp_server, "boulder_progress", {"working_directory": working_dir})
    )
    assert data["auto_deactivated"] is True
    assert data["completed_work_id"] == done_id
    assert data["boulder_retained"] is True
    assert set(data["cleared"]) == {"ralph", "ultrawork", "final_verify"}
    assert (state_dir / BOULDER_FILE).exists()

    retained = json.loads((state_dir / BOULDER_FILE).read_text())
    assert retained["works"][done_id]["status"] == "completed"
    assert retained["active_work_id"] == other_id
    assert retained["works"][other_id]["status"] == "active"
    assert evidence_path.exists()


def test_auto_deactivate_uses_selected_work_id_not_active_work(
    mcp_server, working_dir, tmp_git_root, tmp_path
):
    """F4 auto-deactivate must complete the inspected work_id, not whatever is active."""
    state_dir = tmp_git_root / ".omca" / "state"
    done_content = _make_plan_content(all_done=True)
    done_plan = tmp_path / "done-selected.md"
    done_plan.write_text(done_content)
    active_plan = tmp_path / "still-active.md"
    active_plan.write_text(_make_plan_content(all_done=False))
    done_sha = _plan_sha(done_content)

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(done_plan),
            "plan_name": "done-selected",
            "session_id": "sess-done",
            "working_directory": working_dir,
        },
    )
    done_id = json.loads((state_dir / BOULDER_FILE).read_text())["active_work_id"]
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(active_plan),
            "plan_name": "still-active",
            "session_id": "sess-active",
            "working_directory": working_dir,
        },
    )
    active_id = json.loads((state_dir / BOULDER_FILE).read_text())["active_work_id"]

    _write_json(str(state_dir / RALPH_STATE_FILE), {"task": "do work"})
    _write_json(str(state_dir / ULTRAWORK_STATE_FILE), {"active": True})
    evidence_path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    _write_json(
        str(evidence_path),
        {
            "entries": [
                {
                    "type": "final_verification_f4",
                    "plan_sha256": done_sha,
                    "exit_code": 0,
                    "output_snippet": "verdict:APPROVE",
                    "command": "final check",
                }
            ]
        },
    )

    data = json.loads(
        call_tool(
            mcp_server,
            "boulder_progress",
            {"work_id": done_id, "working_directory": working_dir},
        )
    )
    assert data["auto_deactivated"] is True
    assert data["completed_work_id"] == done_id

    retained = json.loads((state_dir / BOULDER_FILE).read_text())
    assert retained["active_work_id"] == active_id
    assert retained["works"][done_id]["status"] == "completed"
    assert retained["works"][active_id]["status"] == "active"
