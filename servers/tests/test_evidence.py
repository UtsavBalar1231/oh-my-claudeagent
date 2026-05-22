"""Tests for evidence MCP tools."""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import evidence as evidence_module
from tools._common import EVIDENCE_DIR, EVIDENCE_FILE, EVIDENCE_FILE_NEW


def call_tool(server: FastMCP, name: str, args: dict) -> str:
    """Call an MCP tool synchronously and return the text result."""
    result = asyncio.run(server.call_tool(name, args))
    return result[1]["result"]


@pytest.fixture
def mcp_server():
    """Create a FastMCP server with evidence tools registered."""
    server = FastMCP("test-evidence")
    evidence_module.register(server)
    return server


# --- evidence_log ---


def test_evidence_log_creates_file(mcp_server, working_dir, tmp_git_root):
    """evidence_log creates verification-evidence.json with one entry."""
    result = call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 0,
            "output_snippet": "5 passed",
            "working_directory": working_dir,
        },
    )
    assert "1 total" in result
    assert "test" in result

    path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    assert path.exists()
    data = json.loads(path.read_text())
    assert len(data["entries"]) == 1
    entry = data["entries"][0]
    assert entry["type"] == "test"
    assert entry["command"] == "just test"
    assert entry["exit_code"] == 0
    assert entry["output_snippet"] == "5 passed"
    assert "timestamp" in entry


def test_evidence_log_appends_entries(mcp_server, working_dir, tmp_git_root):
    """evidence_log appends a second entry for a total of 2."""
    call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "build",
            "command": "just build",
            "exit_code": 0,
            "output_snippet": "build success",
            "working_directory": working_dir,
        },
    )
    result = call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "lint",
            "command": "just lint",
            "exit_code": 0,
            "output_snippet": "no issues",
            "working_directory": working_dir,
        },
    )
    assert "2 total" in result

    path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    data = json.loads(path.read_text())
    assert len(data["entries"]) == 2
    assert data["entries"][0]["type"] == "build"
    assert data["entries"][1]["type"] == "lint"


def test_evidence_log_truncates_snippet(mcp_server, working_dir, tmp_git_root):
    """evidence_log truncates output_snippet at 2000 characters."""
    long_output = "x" * 5000
    call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 1,
            "output_snippet": long_output,
            "working_directory": working_dir,
        },
    )
    path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    data = json.loads(path.read_text())
    assert len(data["entries"][0]["output_snippet"]) == 2000


# --- evidence_read ---


def test_evidence_read_returns_entries(mcp_server, working_dir):
    """evidence_read returns logged entries as JSON."""
    call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 0,
            "output_snippet": "all good",
            "working_directory": working_dir,
        },
    )
    result = call_tool(
        mcp_server,
        "evidence_read",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert "entries" in data
    assert len(data["entries"]) == 1
    assert data["entries"][0]["command"] == "just test"


def test_evidence_read_handles_missing_file(mcp_server, working_dir):
    """evidence_read returns a graceful message when no evidence exists."""
    result = call_tool(
        mcp_server,
        "evidence_read",
        {"working_directory": working_dir},
    )
    assert "No verification evidence" in result


# --- plan_sha256 field ---

_PLAN_SHA = "deadbeef" * 8  # valid 64-char hex sentinel


def test_evidence_log_with_plan_sha256(mcp_server, working_dir, tmp_git_root):
    """evidence_log stores plan_sha256 when provided."""
    call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 0,
            "output_snippet": f"plan_sha256:{_PLAN_SHA}",
            "working_directory": working_dir,
            "plan_sha256": _PLAN_SHA,
        },
    )
    path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    data = json.loads(path.read_text())
    entry = data["entries"][0]
    assert "plan_sha256" in entry
    assert entry["plan_sha256"] == _PLAN_SHA


def test_evidence_log_without_plan_sha256(mcp_server, working_dir, tmp_git_root):
    """evidence_log omits plan_sha256 key when parameter is not supplied (legacy parity)."""
    call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 0,
            "output_snippet": f"plan_sha256:{_PLAN_SHA}",
            "working_directory": working_dir,
        },
    )
    path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    data = json.loads(path.read_text())
    entry = data["entries"][0]
    assert "plan_sha256" not in entry


def test_evidence_log_empty_plan_sha256(mcp_server, working_dir, tmp_git_root):
    """evidence_log omits plan_sha256 key when passed as empty string (conditional-attach semantics)."""
    call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 0,
            "output_snippet": f"plan_sha256:{_PLAN_SHA}",
            "working_directory": working_dir,
            "plan_sha256": "",
        },
    )
    path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    data = json.loads(path.read_text())
    entry = data["entries"][0]
    assert "plan_sha256" not in entry


# --- legacy path fallback (T3) ---


def test_evidence_log_writes_to_new_path(mcp_server, working_dir, tmp_git_root):
    """evidence_log writes to .omca/evidence/verification-evidence.json (new path)."""
    call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 0,
            "output_snippet": "5 passed",
            "working_directory": working_dir,
        },
    )
    new_path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    assert new_path.exists(), f"Expected new evidence path to exist: {new_path}"
    data = json.loads(new_path.read_text())
    assert len(data["entries"]) == 1
    assert data["entries"][0]["type"] == "test"


def test_evidence_log_legacy_seed_migrates_to_new_path(
    mcp_server, working_dir, tmp_git_root
):
    """Pre-seeded legacy entry is visible after writing a new entry via evidence_log.

    Scenario: legacy file exists with one entry; call evidence_log; assert new path
    has two entries (legacy seed + new one), new path is created.
    """
    # Pre-seed the legacy path
    legacy_path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
    legacy_entry = {
        "type": "build",
        "command": "legacy build",
        "exit_code": 0,
        "output_snippet": "legacy ok",
        "timestamp": "2026-01-01T00:00:00Z",
    }
    legacy_path.write_text(json.dumps({"entries": [legacy_entry]}))

    # Call evidence_log — should read legacy, write to new path
    result = call_tool(
        mcp_server,
        "evidence_log",
        {
            "evidence_type": "test",
            "command": "just test",
            "exit_code": 0,
            "output_snippet": "new entry",
            "working_directory": working_dir,
        },
    )
    assert "2 total" in result

    new_path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    assert new_path.exists(), "New evidence path must be created"
    data = json.loads(new_path.read_text())
    assert len(data["entries"]) == 2
    assert data["entries"][0]["command"] == "legacy build"
    assert data["entries"][1]["command"] == "just test"


def test_evidence_read_falls_back_to_legacy(mcp_server, working_dir, tmp_git_root):
    """evidence_read returns legacy entries when only the legacy path exists."""
    # Only write the legacy path; do NOT create the new path
    legacy_path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
    legacy_entry = {
        "type": "lint",
        "command": "just lint",
        "exit_code": 0,
        "output_snippet": "no issues",
        "timestamp": "2026-01-01T00:00:00Z",
    }
    legacy_path.write_text(json.dumps({"entries": [legacy_entry]}))

    # New path must NOT exist
    new_path = tmp_git_root / EVIDENCE_DIR / EVIDENCE_FILE_NEW
    assert not new_path.exists()

    result = call_tool(
        mcp_server,
        "evidence_read",
        {"working_directory": working_dir},
    )
    data = json.loads(result)
    assert len(data["entries"]) == 1
    assert data["entries"][0]["command"] == "just lint"
