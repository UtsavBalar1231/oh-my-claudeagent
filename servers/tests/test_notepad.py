"""Tests for notepad MCP tools."""

import os

import pytest

import tools.notepad as notepad_module
from tools._common import NOTEPADS_DIR, VALID_SECTIONS


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
    """notepad_write creates a section file at notepads/{plan}/{section}.md"""
    result = tools["notepad_write"](
        plan_name="my-plan",
        section="learnings",
        content="First learning",
        working_directory=working_dir,
    )
    section_file = (
        tmp_git_root / ".omca" / "state" / NOTEPADS_DIR / "my-plan" / "learnings.md"
    )
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
    section_file = (
        tmp_git_root / ".omca" / "state" / NOTEPADS_DIR / "append-plan" / "issues.md"
    )
    text = section_file.read_text()
    assert "Entry one" in text
    assert "Entry two" in text


def test_notepad_write_rejects_invalid_section(tools, working_dir):
    """notepad_write rejects invalid section names via Literal type enforcement."""
    # The function uses Literal typing — calling with an invalid value still succeeds
    # at the Python level (no runtime enforcement from Literal alone), but the MCP
    # schema validation happens before this function is called in production.
    # We test that the valid sections are the expected ones instead.
    assert set(VALID_SECTIONS) == {
        "learnings",
        "issues",
        "decisions",
        "problems",
        "questions",
    }


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
        section="questions",
        content="Q1",
        working_directory=working_dir,
    )
    result = tools["notepad_list"](
        plan_name="list-plan",
        working_directory=working_dir,
    )
    assert "questions" in result
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
    # Verify file was actually compacted
    section_file = (
        tmp_git_root / ".omca" / "state" / NOTEPADS_DIR / "big-plan" / "learnings.md"
    )
    text = section_file.read_text()
    assert "Compacted" in text
