"""Tests for validate_plan_write MCP tool."""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import validate_plan_write as vpw_module


def call_tool(server: FastMCP, name: str, args: dict) -> str:
    """Call an MCP tool synchronously and return the text result."""
    result = asyncio.run(server.call_tool(name, args))
    return result[1]["result"]


@pytest.fixture
def mcp_server():
    """Create a FastMCP server with validate_plan_write registered."""
    server = FastMCP("test-validate-plan-write")
    vpw_module.register(server)
    return server


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_PLAN_PATH = "/home/user/.claude/plans/my-agent-abc123.md"
_AGENT_PATH = "/home/user/.claude/plans/cool-cooking-sifakis-agent-deadbeef.md"
_NON_PLAN_PATH = "/tmp/notes.md"


def _allow_result(result: str) -> bool:
    """Return True when the tool returned a no-op allow ({})."""
    try:
        return result.strip() == "{}" or not json.loads(result)
    except json.JSONDecodeError:
        return False


def _deny_result(result: str) -> bool:
    """Return True when the tool returned a deny decision."""
    try:
        data = json.loads(result)
        hso = data.get("hookSpecificOutput", {})
        return (
            hso.get("hookEventName") == "PreToolUse"
            and hso.get("permissionDecision") == "deny"
        )
    except (json.JSONDecodeError, AttributeError):
        return False


def _deny_reason(result: str) -> str:
    """Extract the deny reason from the result."""
    data = json.loads(result)
    return data["hookSpecificOutput"]["permissionDecisionReason"]


# ---------------------------------------------------------------------------
# Write tool — content field
# ---------------------------------------------------------------------------


def test_write_plan_with_checkboxes_allows(mcp_server):
    """Write: plan with ## TODOs header and checkboxes → allow ({})."""
    content = "# My Plan\n\n## TODOs\n\n- [ ] 1. Do the first thing\n- [ ] 2. Do the second thing\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _PLAN_PATH,
            "content": content,
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


def test_write_plan_with_work_objectives_and_checkboxes_allows(mcp_server):
    """Write: plan with ## Work Objectives header and checkboxes → allow."""
    content = "# Sprint Plan\n\n## Work Objectives\n\n- [ ] 1. Implement feature\n- [ ] 2. Write tests\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _PLAN_PATH,
            "content": content,
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


def test_write_plan_missing_checkboxes_denies(mcp_server):
    """Write: plan with ## TODOs but no checkboxes → deny with reason."""
    content = "# My Plan\n\n## TODOs\n\nno checkboxes here, just prose\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _PLAN_PATH,
            "content": content,
        },
    )
    assert _deny_result(result), f"Expected deny, got: {result}"
    reason = _deny_reason(result)
    assert "checkbox" in reason.lower() or "- [ ]" in reason


def test_write_agent_named_plan_missing_checkboxes_denies(mcp_server):
    """Write: *-agent-*.md filename with no checkboxes and no header → deny."""
    content = "# Agent Plan\n\nThis plan has no checkboxes at all.\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _AGENT_PATH,
            "content": content,
        },
    )
    assert _deny_result(result), f"Expected deny, got: {result}"


def test_write_agent_named_plan_with_checkboxes_allows(mcp_server):
    """Write: *-agent-*.md filename with checkboxes → allow."""
    content = "# Agent Plan\n\n- [ ] 1. First task\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _AGENT_PATH,
            "content": content,
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


def test_write_non_plan_path_allows(mcp_server):
    """Write: path not matching */plans/*.md → allow regardless of content."""
    content = "# My Plan\n\n## TODOs\n\nno checkboxes\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _NON_PLAN_PATH,
            "content": content,
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


def test_write_plans_readme_without_header_allows(mcp_server):
    """Write: plans/README.md without plan header → allow (not a plan)."""
    content = "# Plans directory\n\nThis directory stores plan files.\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": "/home/user/.claude/plans/README.md",
            "content": content,
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


# ---------------------------------------------------------------------------
# Edit tool — new_string field (NOT content)
# ---------------------------------------------------------------------------


def test_edit_plan_new_string_with_checkboxes_allows(mcp_server):
    """Edit: new_string containing checkboxes on a plan file → allow."""
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Edit",
            "file_path": _PLAN_PATH,
            "old_string": "## TODOs\n\nno checkboxes",
            "new_string": "## TODOs\n\n- [ ] 1. First task\n- [ ] 2. Second task\n",
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


def test_edit_plan_new_string_without_checkboxes_denies(mcp_server):
    """Edit: new_string without checkboxes on plan file with ## TODOs header → deny."""
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Edit",
            "file_path": _PLAN_PATH,
            "old_string": "## TODOs\n\n- [ ] 1. Old task",
            "new_string": "## TODOs\n\nno checkboxes here anymore",
        },
    )
    assert _deny_result(result), f"Expected deny, got: {result}"


def test_edit_uses_new_string_not_content(mcp_server):
    """Edit: content is ignored — only new_string is checked for Edit tool."""
    # content has checkboxes (wrong field for Edit), new_string does not
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Edit",
            "file_path": _PLAN_PATH,
            "content": "## TODOs\n\n- [ ] 1. Checkbox in wrong field\n",
            "new_string": "## TODOs\n\nno checkboxes in new_string",
        },
    )
    assert _deny_result(result), (
        "Edit must inspect new_string, not content. Expected deny, got: " + result
    )


def test_edit_non_plan_path_allows(mcp_server):
    """Edit: path not matching */plans/*.md → allow."""
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Edit",
            "file_path": _NON_PLAN_PATH,
            "old_string": "foo",
            "new_string": "## TODOs\n\nno checkboxes",
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


# ---------------------------------------------------------------------------
# Non-Write/Edit tools — ignored
# ---------------------------------------------------------------------------


def test_read_tool_is_ignored(mcp_server):
    """Read tool input is ignored — allow always."""
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Read",
            "file_path": _PLAN_PATH,
        },
    )
    assert _allow_result(result), f"Expected allow, got: {result}"


# ---------------------------------------------------------------------------
# Response shape — verify JSON structure for PreToolUse hook protocol
# ---------------------------------------------------------------------------


def test_deny_response_shape(mcp_server):
    """Deny response must have hookSpecificOutput.permissionDecision == 'deny'."""
    content = "# My Plan\n\n## TODOs\n\nno checkboxes\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _PLAN_PATH,
            "content": content,
        },
    )
    data = json.loads(result)
    hso = data["hookSpecificOutput"]
    assert hso["hookEventName"] == "PreToolUse"
    assert hso["permissionDecision"] == "deny"
    assert isinstance(hso["permissionDecisionReason"], str)
    assert len(hso["permissionDecisionReason"]) > 0


def test_allow_response_shape(mcp_server):
    """Allow response must be a valid JSON object (empty or falsy)."""
    content = "# My Plan\n\n## TODOs\n\n- [ ] 1. Task one\n"
    result = call_tool(
        mcp_server,
        "validate_plan_write",
        {
            "tool_name": "Write",
            "file_path": _PLAN_PATH,
            "content": content,
        },
    )
    data = json.loads(result)
    # Empty JSON object {} — no hookSpecificOutput
    assert "permissionDecision" not in data
    assert "hookSpecificOutput" not in data
