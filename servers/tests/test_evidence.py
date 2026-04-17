"""Tests for evidence MCP tools."""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import evidence as evidence_module
from tools._common import EVIDENCE_FILE


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

    path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
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

    path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
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
    path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
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
    path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
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
    path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
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
    path = tmp_git_root / ".omca" / "state" / EVIDENCE_FILE
    data = json.loads(path.read_text())
    entry = data["entries"][0]
    assert "plan_sha256" not in entry
