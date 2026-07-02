"""Tests for the session_search MCP tool."""

import json

import pytest

import tools.sessions as sessions_module


def _get_tools():
    """Extract tool functions from the sessions module by calling register() on a mock."""
    from unittest.mock import MagicMock

    captured = {}
    mock_mcp = MagicMock()

    def tool_decorator(*args, **kwargs):
        def wrapper(fn):
            captured[fn.__name__] = fn
            return fn

        if args and callable(args[0]):
            fn = args[0]
            captured[fn.__name__] = fn
            return fn
        return wrapper

    mock_mcp.tool = tool_decorator
    sessions_module.register(mock_mcp)
    return captured


@pytest.fixture
def tools():
    return _get_tools()


def _write_line(f, obj):
    with open(f, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj) + "\n")


@pytest.fixture
def transcripts_root(tmp_path, monkeypatch):
    """Point the tool at a scratch transcripts root and return (root, project_dir)."""
    root = tmp_path / "projects"
    root.mkdir()
    monkeypatch.setenv("OMCA_TRANSCRIPTS_ROOT", str(root))
    return root


def _make_project(root, project_path):
    from pathlib import Path

    slug = sessions_module._slugify(project_path)
    d = Path(root) / slug
    d.mkdir(parents=True, exist_ok=True)
    return d


# --- Happy path ---


def test_match_found_with_role_and_excerpt(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    _write_line(
        f,
        {
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "the migration plan is solid"}],
            },
        },
    )
    result = json.loads(
        tools["session_search"](query="migration plan", project_path="/home/user/proj")
    )
    assert result["matches"], result
    m = result["matches"][0]
    assert m["role"] == "assistant"
    assert "migration plan" in m["excerpt"]


def test_case_insensitive_substring_match(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    _write_line(
        f,
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"role": "user", "content": "Please FIX the Bug"},
        },
    )
    result = json.loads(
        tools["session_search"](query="fix the bug", project_path="/home/user/proj")
    )
    assert len(result["matches"]) == 1


# --- Role filter ---


def test_role_filter_excludes_other_roles(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    _write_line(
        f,
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"role": "user", "content": "banana split"},
        },
    )
    _write_line(
        f,
        {
            "type": "assistant",
            "timestamp": "2026-01-01T00:01:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "banana bread recipe"}],
            },
        },
    )
    result = json.loads(
        tools["session_search"](
            query="banana", project_path="/home/user/proj", role="user"
        )
    )
    assert len(result["matches"]) == 1
    assert result["matches"][0]["role"] == "user"


def test_role_filter_matches_tool_result_blocks(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    _write_line(
        f,
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "content": "build succeeded with 0 errors",
                    }
                ],
            },
        },
    )
    result = json.loads(
        tools["session_search"](
            query="build succeeded", project_path="/home/user/proj", role="tool"
        )
    )
    assert len(result["matches"]) == 1
    assert result["matches"][0]["role"] == "tool"


# --- Limit cap + truncation notice ---


def test_limit_cap_and_truncation_notice(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    for i in range(5):
        _write_line(
            f,
            {
                "type": "user",
                "timestamp": f"2026-01-01T00:0{i}:00Z",
                "message": {"role": "user", "content": f"needle occurrence {i}"},
            },
        )
    result = json.loads(
        tools["session_search"](query="needle", project_path="/home/user/proj", limit=2)
    )
    assert len(result["matches"]) == 2
    assert result["truncated"] is True
    assert "[TRUNCATED]" in result["note"]


def test_limit_hard_max_clamped(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    _write_line(
        f,
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"role": "user", "content": "needle"},
        },
    )
    # limit=1000 should be silently clamped to MAX_LIMIT (50), not error
    result = json.loads(
        tools["session_search"](
            query="needle", project_path="/home/user/proj", limit=1000
        )
    )
    assert result["truncated"] is False
    assert len(result["matches"]) == 1


# --- Malformed lines ---


def test_malformed_lines_skipped_silently(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    with open(f, "a", encoding="utf-8") as fh:
        fh.write("{not valid json\n")
        fh.write("\n")
    _write_line(
        f,
        {
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "needle here"}],
            },
        },
    )
    result = json.loads(
        tools["session_search"](query="needle", project_path="/home/user/proj")
    )
    assert len(result["matches"]) == 1


# --- Missing slug dir ---


def test_missing_project_dir_returns_empty_gracefully(tools, transcripts_root):
    result = json.loads(
        tools["session_search"](
            query="anything", project_path="/home/user/nonexistent-project"
        )
    )
    assert result["matches"] == []
    assert "note" in result
