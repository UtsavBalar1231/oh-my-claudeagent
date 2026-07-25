"""Tests for the session_search MCP tool."""

import json
import os

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


# --- Spilled tool results ---


def _write_sidecar(project_dir, session, name, text):
    d = project_dir / session / "tool-results"
    d.mkdir(parents=True, exist_ok=True)
    f = d / name
    f.write_text(text, encoding="utf-8")
    return f


def test_spilled_tool_result_is_searched(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    _write_sidecar(
        project_dir,
        "sess-a",
        "spill1.txt",
        "x" * 500 + "needle in the spill" + "y" * 500,
    )
    result = json.loads(
        tools["session_search"](
            query="needle in the spill", project_path="/home/user/proj"
        )
    )
    assert len(result["matches"]) == 1
    m = result["matches"][0]
    assert m["role"] == "tool"
    assert "needle in the spill" in m["excerpt"]
    # Excerpt stays inside the ~200 char budget around the hit
    assert len(m["excerpt"]) <= len("needle in the spill") + 2 * 100
    # No timestamp in the file, so mtime stands in for one
    assert m["timestamp"]
    assert m["file"] == "sess-a/tool-results/spill1.txt"


def test_sidecar_skipped_for_non_tool_role_filter(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    _write_sidecar(project_dir, "sess-a", "spill1.txt", "needle in the spill")
    result = json.loads(
        tools["session_search"](
            query="needle", project_path="/home/user/proj", role="user"
        )
    )
    assert result["matches"] == []


def test_subagent_transcripts_are_out_of_scope(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    sub = project_dir / "sess-a" / "subagents" / "workflows" / "wf_1"
    sub.mkdir(parents=True)
    _write_line(
        sub / "agent-1.jsonl",
        {
            "type": "assistant",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "needle from a subagent"}],
            },
        },
    )
    result = json.loads(
        tools["session_search"](query="needle", project_path="/home/user/proj")
    )
    assert result["matches"] == []


def test_sidecar_and_jsonl_ordered_newest_first(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    f = project_dir / "session1.jsonl"
    _write_line(
        f,
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {"role": "user", "content": "needle in the jsonl"},
        },
    )
    sidecar = _write_sidecar(project_dir, "sess-a", "spill1.txt", "needle in the spill")
    os.utime(f, (1_700_000_000, 1_700_000_000))
    os.utime(sidecar, (1_800_000_000, 1_800_000_000))

    result = json.loads(
        tools["session_search"](query="needle", project_path="/home/user/proj")
    )
    roles = [m["role"] for m in result["matches"]]
    assert roles == ["tool", "user"]


def _spill_pointer(sidecar, preview):
    """Mirror the inline text the platform leaves in place of a spilled result."""
    return (
        "<persisted-output>\n"
        f"Output too large (47.5KB). Full output saved to: {sidecar}\n\n"
        f"Preview (first 2KB):\n{preview}\n...\n</persisted-output>"
    )


def test_inline_spill_preview_not_counted_twice(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    body = "needle in the spill" + "y" * 500
    sidecar = _write_sidecar(project_dir, "sess-a", "spill1.txt", body)
    _write_line(
        project_dir / "sess-a.jsonl",
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "content": _spill_pointer(sidecar, body[:200]),
                    }
                ],
            },
        },
    )
    result = json.loads(
        tools["session_search"](
            query="needle in the spill", project_path="/home/user/proj"
        )
    )
    assert len(result["matches"]) == 1, result
    assert result["matches"][0]["file"] == "sess-a/tool-results/spill1.txt"


def test_inline_spill_preview_kept_when_sidecar_is_gone(tools, transcripts_root):
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    sidecar = project_dir / "sess-a" / "tool-results" / "swept.txt"
    _write_line(
        project_dir / "sess-a.jsonl",
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "content": _spill_pointer(sidecar, "needle in the spill"),
                    }
                ],
            },
        },
    )
    result = json.loads(
        tools["session_search"](
            query="needle in the spill", project_path="/home/user/proj"
        )
    )
    assert len(result["matches"]) == 1, result
    assert result["matches"][0]["role"] == "tool"
    assert result["matches"][0]["file"] == "sess-a.jsonl"


def test_inline_tool_result_without_spill_pointer_still_matches(
    tools, transcripts_root
):
    """A plain tool result must not be suppressed just because sidecars exist."""
    project_dir = _make_project(str(transcripts_root), "/home/user/proj")
    _write_sidecar(project_dir, "sess-a", "spill1.txt", "unrelated spill body")
    _write_line(
        project_dir / "sess-a.jsonl",
        {
            "type": "user",
            "timestamp": "2026-01-01T00:00:00Z",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "content": "needle stayed inline"}],
            },
        },
    )
    result = json.loads(
        tools["session_search"](
            query="needle stayed inline", project_path="/home/user/proj"
        )
    )
    assert len(result["matches"]) == 1, result
    assert result["matches"][0]["file"] == "sess-a.jsonl"


# --- Missing slug dir ---


def test_missing_project_dir_returns_empty_gracefully(tools, transcripts_root):
    result = json.loads(
        tools["session_search"](
            query="anything", project_path="/home/user/nonexistent-project"
        )
    )
    assert result["matches"] == []
    assert "note" in result
