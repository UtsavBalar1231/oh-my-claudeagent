"""Tests for notepad MCP tools."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

import tools.notepad as notepad_module
from tests._mcp_helpers import call_tool
from tools._common import VALID_SECTIONS


@pytest.fixture
def mcp_server():
    """Create an MCPServer with notepad tools registered."""
    server = MCPServer("test-notepad")
    notepad_module.register(server)
    return server


def _get_tools(working_dir):
    """Extract tool functions from the notepad module by calling register() on a mock."""
    from unittest.mock import MagicMock

    captured = {}
    mock_mcp = MagicMock()

    def tool_decorator(*args, **kwargs):
        def wrapper(fn):
            captured[fn.__name__] = fn
            return fn

        # Called as @mcp.tool() or @mcp.tool(annotations=...)
        if args and callable(args[0]):
            fn = args[0]
            captured[fn.__name__] = fn
            return fn
        return wrapper

    mock_mcp.tool = tool_decorator
    notepad_module.register(mock_mcp)
    return captured


@pytest.fixture
def tools(working_dir):
    return _get_tools(working_dir)


def state_dir(tmp_git_root):
    return str(tmp_git_root / ".omca" / "state")


# --- notepad_write ---


def test_notepad_write_creates_section_file(tools, tmp_git_root, working_dir):
    """notepad_write creates a section file at .omca/notepads/{plan}/{section}.md (new path)."""
    result = tools["notepad_write"](
        plan_name="my-plan",
        section="learnings",
        content="First learning",
        working_directory=working_dir,
    )
    # Writer uses new canonical path
    section_file = tmp_git_root / ".omca" / "notepads" / "my-plan" / "learnings.md"
    assert section_file.exists()
    assert "First learning" in section_file.read_text()
    assert "my-plan/learnings.md" in result


def test_notepad_write_appends(tools, tmp_git_root, working_dir):
    """notepad_write appends — both entries present after two writes."""
    tools["notepad_write"](
        plan_name="append-plan",
        section="issues",
        content="Entry one",
        working_directory=working_dir,
    )
    tools["notepad_write"](
        plan_name="append-plan",
        section="issues",
        content="Entry two",
        working_directory=working_dir,
    )
    section_file = tmp_git_root / ".omca" / "notepads" / "append-plan" / "issues.md"
    text = section_file.read_text()
    assert "Entry one" in text
    assert "Entry two" in text


@pytest.mark.parametrize("bad_section", ["questions", "notes"])
def test_notepad_write_rejects_unknown_section(
    mcp_server, working_dir, tmp_git_root, bad_section
):
    """An unlisted section is rejected by the server's own argument validation."""
    with pytest.raises(ToolError, match=bad_section):
        call_tool(
            mcp_server,
            "notepad_write",
            {
                "plan_name": "reject-plan",
                "section": bad_section,
                "content": "should not land",
                "working_directory": working_dir,
            },
        )
    assert not (tmp_git_root / ".omca" / "notepads" / "reject-plan").exists()


def test_notepad_write_accepts_every_declared_section(
    mcp_server, working_dir, tmp_git_root
):
    """The mirror of the rejection test: VALID_SECTIONS is exactly what the server takes."""
    for section in VALID_SECTIONS:
        call_tool(
            mcp_server,
            "notepad_write",
            {
                "plan_name": "accept-plan",
                "section": section,
                "content": f"entry for {section}",
                "working_directory": working_dir,
            },
        )
        path = tmp_git_root / ".omca" / "notepads" / "accept-plan" / f"{section}.md"
        assert path.exists(), f"{section} is in VALID_SECTIONS but the tool rejected it"


# --- notepad_read ---


def test_notepad_read_returns_content(tools, tmp_git_root, working_dir):
    """notepad_read returns content for an existing section."""
    tools["notepad_write"](
        plan_name="read-plan",
        section="decisions",
        content="Use pytest",
        working_directory=working_dir,
    )
    result = tools["notepad_read"](
        plan_name="read-plan",
        section="decisions",
        working_directory=working_dir,
    )
    assert "Use pytest" in result
    assert "Decisions" in result


def test_notepad_read_missing_plan(tools, working_dir):
    """notepad_read returns a helpful message for a missing plan."""
    result = tools["notepad_read"](
        plan_name="nonexistent-plan",
        section="learnings",
        working_directory=working_dir,
    )
    assert "nonexistent-plan" in result
    assert "No notepad" in result


def test_notepad_read_all_sections(tools, working_dir):
    """notepad_read with section=None returns all written sections."""
    tools["notepad_write"](
        plan_name="multi-plan",
        section="learnings",
        content="Learning A",
        working_directory=working_dir,
    )
    tools["notepad_write"](
        plan_name="multi-plan",
        section="problems",
        content="Problem B",
        working_directory=working_dir,
    )
    result = tools["notepad_read"](
        plan_name="multi-plan",
        section=None,
        working_directory=working_dir,
    )
    assert "Learning A" in result
    assert "Problem B" in result


# --- notepad_list ---


def test_notepad_list_returns_sections(tools, working_dir):
    """notepad_list returns section names for an existing plan."""
    tools["notepad_write"](
        plan_name="list-plan",
        section="decisions",
        content="D1",
        working_directory=working_dir,
    )
    result = tools["notepad_list"](
        plan_name="list-plan",
        working_directory=working_dir,
    )
    assert "decisions" in result
    assert "list-plan" in result


def test_notepad_list_missing_plan(tools, working_dir):
    """notepad_list returns a helpful message for a missing/empty plan."""
    # When the notepads directory doesn't exist at all, returns "No notepads found."
    # When the notepads dir exists but the plan doesn't, returns "No notepad found for plan: X"
    # Either way it is a graceful not-found message.
    result = tools["notepad_list"](
        plan_name="ghost-plan",
        working_directory=working_dir,
    )
    assert "No notepad" in result or "No notepads" in result


# --- notepad_compact ---


def test_notepad_compact_no_compaction_needed(tools, working_dir):
    """notepad_compact returns no-op message when fewer than 20 lines."""
    tools["notepad_write"](
        plan_name="compact-plan",
        section="learnings",
        content="Short content",
        working_directory=working_dir,
    )
    result = tools["notepad_compact"](
        plan_name="compact-plan",
        section="learnings",
        working_directory=working_dir,
    )
    assert "no compaction needed" in result or "lines" in result


def test_notepad_compact_reduces_large_section(tools, tmp_git_root, working_dir):
    """notepad_compact removes older entries when section has more than 20 lines."""
    # Write enough entries to exceed 20 lines
    for i in range(25):
        tools["notepad_write"](
            plan_name="big-plan",
            section="learnings",
            content=f"Entry {i}",
            working_directory=working_dir,
        )
    result = tools["notepad_compact"](
        plan_name="big-plan",
        section="learnings",
        working_directory=working_dir,
    )
    assert "removed" in result or "Compacted" in result
    # Verify file was actually compacted — write uses new path, compact reads via fallback
    section_file = tmp_git_root / ".omca" / "notepads" / "big-plan" / "learnings.md"
    text = section_file.read_text()
    assert "Compacted" in text


def test_notepad_write_creates_canonical_path(tools, tmp_git_root, working_dir):
    """notepad_write places the new entry at .omca/notepads/<plan>/<section>.md (canonical path only)."""
    tools["notepad_write"](
        plan_name="new-path-plan",
        section="decisions",
        content="New path entry",
        working_directory=working_dir,
    )
    new_file = tmp_git_root / ".omca" / "notepads" / "new-path-plan" / "decisions.md"
    assert new_file.exists()
    assert "New path entry" in new_file.read_text()


def test_notepad_read_ignores_legacy_path(tools, tmp_git_root, working_dir):
    """notepad_read returns not-found when only a legacy-path dir exists (legacy path no longer consulted)."""
    legacy_dir = tmp_git_root / ".omca" / "state" / "notepads" / "legacy-plan"
    legacy_dir.mkdir(parents=True, exist_ok=True)
    (legacy_dir / "learnings.md").write_text("## legacy entry\n\nLegacy content\n")

    result = tools["notepad_read"](
        plan_name="legacy-plan",
        section="learnings",
        working_directory=working_dir,
    )
    assert "No notepad" in result
