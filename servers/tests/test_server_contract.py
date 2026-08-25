"""Contract tests for the shipped omca MCP server."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tests._mcp_helpers import call_tool
from tools import ast as ast_tools

CLIENT_TEXT_CAP_CHARS = 2048

WRITE_TOOLS = frozenset(
    {
        "ast_replace",
        "boulder_write",
        "evidence_log",
        "notepad_compact",
        "notepad_write",
    }
)

# Kept deliberately small. Each entry stays in every session's cached prefix and
# invalidates that cache on any tool change, so the set covers only the tools an
# agent must reach without a tool-search step.
ALWAYS_LOAD_TOOLS = frozenset({"boulder_progress", "evidence_log", "notepad_write"})

# Raises the client's persist-to-disk threshold for a tool's text result.
MAX_RESULT_SIZE_CHARS = {
    "ast_search": 200_000,
    "evidence_read": 100_000,
    "file_read": 200_000,
    "session_search": 100_000,
}

EXPECTED_TOOLS = frozenset(
    {
        "agents_list",
        "ast_dump_tree",
        "ast_find_rule",
        "ast_replace",
        "ast_search",
        "ast_test_rule",
        "boulder_progress",
        "boulder_write",
        "categories_list",
        "evidence_log",
        "evidence_read",
        "file_read",
        "health_check",
        "notepad_compact",
        "notepad_list",
        "notepad_read",
        "notepad_write",
        "session_search",
        "validate_plan_write",
    }
)

READ_ONLY_TOOLS = sorted(EXPECTED_TOOLS - WRITE_TOOLS)


def _load_server():
    """Import the shipped entry point by path; its filename is not a valid module name."""
    path = os.path.join(os.path.dirname(__file__), "..", "omca-mcp.py")
    spec = importlib.util.spec_from_file_location("omca_mcp_entrypoint", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def server():
    return _load_server().mcp


@pytest.fixture(scope="module")
def tools(server):
    return sorted(asyncio.run(server.list_tools()), key=lambda t: t.name)


def test_server_declares_instructions(server):
    """Instructions plus bare tool names are all that load at session start under tool search."""
    assert server.instructions, (
        "server must declare instructions or its tools go unfound"
    )
    assert len(server.instructions) <= CLIENT_TEXT_CAP_CHARS, (
        f"instructions are {len(server.instructions)} chars; the client truncates at "
        f"{CLIENT_TEXT_CAP_CHARS} and would silently drop the tail"
    )


def test_no_tool_declares_an_output_schema(tools):
    """No tool declares an outputSchema."""
    offenders = [t.name for t in tools if t.output_schema is not None]
    assert not offenders, (
        f"tools declaring an outputSchema: {offenders}. Pass structured_output=False "
        "to @mcp.tool() unless the model genuinely needs to parse exact fields."
    )


def test_every_tool_declares_annotations(tools):
    """Every tool declares annotations with readOnlyHint set and openWorldHint False."""
    for tool in tools:
        assert tool.annotations is not None, f"{tool.name} declares no annotations"
        assert tool.annotations.read_only_hint is not None, (
            f"{tool.name} leaves readOnlyHint unset, so the client cannot batch it"
        )
        assert tool.annotations.open_world_hint is False, (
            f"{tool.name} must declare openWorldHint=False; every omca tool is local"
        )


def test_write_tools_are_exactly_the_declared_set(tools):
    actual = {t.name for t in tools if t.annotations.read_only_hint is False}
    assert actual == WRITE_TOOLS


def test_destructive_hint_only_on_write_tools(tools):
    """The spec makes destructiveHint meaningful only when readOnlyHint is false."""
    for tool in tools:
        if tool.name in WRITE_TOOLS:
            assert tool.annotations.destructive_hint is not None, (
                f"{tool.name} writes, so state its destructiveHint explicitly"
            )
        else:
            assert tool.annotations.destructive_hint is None, (
                f"{tool.name} is read-only; destructiveHint there is noise"
            )


def test_always_load_is_exactly_the_declared_set(tools):
    """Server-wide alwaysLoad is gone; only these tools opt in per-tool."""
    actual = {t.name for t in tools if (t.meta or {}).get("anthropic/alwaysLoad")}
    assert actual == ALWAYS_LOAD_TOOLS, (
        f"unexpectedly eager: {sorted(actual - ALWAYS_LOAD_TOOLS)}; "
        f"expected but deferred: {sorted(ALWAYS_LOAD_TOOLS - actual)}"
    )


def test_max_result_size_chars_matches_the_declared_values(tools):
    actual = {
        t.name: (t.meta or {}).get("anthropic/maxResultSizeChars")
        for t in tools
        if (t.meta or {}).get("anthropic/maxResultSizeChars") is not None
    }
    assert actual == MAX_RESULT_SIZE_CHARS


def test_write_tools_declare_a_human_readable_title(tools):
    """The client shows a write tool's title in /mcp and in the permission dialog,
    where it would otherwise print the raw namespaced tool name."""
    for tool in tools:
        title = tool.annotations.title
        if tool.name in WRITE_TOOLS:
            assert title, (
                f"{tool.name} writes and needs a title for the permission dialog"
            )
        else:
            assert title is None, f"{tool.name} declares a title it does not need"


def test_every_tool_declares_a_search_hint(tools):
    """Every tool declares _meta["anthropic/searchHint"]."""
    for tool in tools:
        hint = (tool.meta or {}).get("anthropic/searchHint")
        assert hint, f"{tool.name} has no anthropic/searchHint"


def test_tool_descriptions_fit_the_client_cap(tools):
    for tool in tools:
        assert tool.description, f"{tool.name} has no description"
        assert len(tool.description) <= CLIENT_TEXT_CAP_CHARS, (
            f"{tool.name} description is {len(tool.description)} chars; the client "
            f"truncates at {CLIENT_TEXT_CAP_CHARS}"
        )


def test_registered_tools_are_exactly_the_declared_roster(tools):
    """The registered tool names equal EXPECTED_TOOLS exactly."""
    actual = {t.name for t in tools}
    assert actual == EXPECTED_TOOLS, (
        f"registered but undeclared: {sorted(actual - EXPECTED_TOOLS)}; "
        f"declared but unregistered: {sorted(EXPECTED_TOOLS - actual)}. Update "
        "EXPECTED_TOOLS only when the tool surface changes deliberately."
    )


@pytest.fixture(scope="module")
def sg_bin():
    """The ast-grep path the entry point would install, or None when it is absent."""
    try:
        return ast_tools.discover_binary()
    except SystemExit:
        return None


def smoke_args(tool_name: str, root) -> dict:
    """Arguments that exercise one read-only tool entirely inside `root`."""
    sample = root / "sample.py"
    sample.write_text("def f():\n    print(1)\n")
    rule = "id: smoke\nlanguage: python\nrule:\n  pattern: print($A)\n"
    return {
        "agents_list": {"working_directory": str(root)},
        "ast_dump_tree": {"code": "print($A)", "language": "python"},
        "ast_find_rule": {"rule_yaml": rule},
        "ast_search": {"pattern": "print($A)", "lang": "python"},
        "ast_test_rule": {"code": "print(1)\n", "rule_yaml": rule},
        "boulder_progress": {"working_directory": str(root)},
        "categories_list": {"working_directory": str(root)},
        "evidence_read": {"working_directory": str(root)},
        "file_read": {"path": str(sample)},
        "health_check": {"working_directory": str(root)},
        "notepad_list": {"plan_name": "smoke", "working_directory": str(root)},
        "notepad_read": {"plan_name": "smoke", "working_directory": str(root)},
        "session_search": {"query": "smoke", "project_path": str(root)},
        "validate_plan_write": {
            "tool_name": "Write",
            "file_path": str(root / "notes.md"),
            "content": "# notes\n",
        },
    }[tool_name]


@pytest.mark.parametrize("tool_name", READ_ONLY_TOOLS)
def test_read_only_tools_answer_through_the_real_server(
    server, tool_name, tmp_git_root, sg_bin, monkeypatch
):
    """Every read-only tool survives one call over the server's own dispatch path."""
    if tool_name.startswith("ast_"):
        if sg_bin is None:
            pytest.skip("ast-grep binary not installed; ast_* tools cannot be called")
        monkeypatch.setattr(ast_tools, "_SG_BIN", sg_bin)
        monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_git_root))

    result = call_tool(server, tool_name, smoke_args(tool_name, tmp_git_root))
    assert isinstance(result, str) and result, f"{tool_name} returned no text content"
