"""Tests for the session-bound boulder plan registry (boulder_write/boulder_progress)."""

import asyncio
import json
import os
import subprocess
import sys
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP

from tools import _boulder_core, boulder as boulder_module
from tools._common import BOULDER_FILE

FIXTURES_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "tests", "fixtures", "boulder-schemas"
)


def load_fixture(name: str) -> dict:
    with open(os.path.join(FIXTURES_DIR, f"{name}.json")) as f:
        return json.load(f)


def load_fixture_raw(name: str) -> str:
    with open(os.path.join(FIXTURES_DIR, f"{name}.json")) as f:
        return f.read()


def call_tool(server: FastMCP, name: str, args: dict) -> str:
    """Call an MCP tool synchronously and return the text result."""
    result = asyncio.run(server.call_tool(name, args))
    # result is (list[ContentBlock], {'result': str})
    return result[1]["result"]


@pytest.fixture
def mcp_server():
    """Create a FastMCP server with boulder tools registered."""
    server = FastMCP("test-boulder")
    boulder_module.register(server)
    return server


# --- boulder_write: registry schema ---


def test_boulder_write_creates_registry_state_file(
    mcp_server, working_dir, tmp_git_root
):
    """boulder_write creates a registry boulder.json with plans[plan_name] + bindings."""
    result = call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )
    assert "my-plan" in result
    assert "sessions=1" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    assert path.exists()
    data = json.loads(path.read_text())
    assert data["plans"]["my-plan"]["active_plan"] == "/tmp/plan.md"
    assert data["plans"]["my-plan"]["session_ids"] == ["sess-001"]
    assert "started_at" in data["plans"]["my-plan"]
    assert "agent" in data["plans"]["my-plan"]
    assert data["bindings"]["sess-001"]["plan_name"] == "my-plan"
    assert "bound_at" in data["bindings"]["sess-001"]


def test_boulder_write_appends_sessions(mcp_server, working_dir, tmp_git_root):
    """boulder_write with two different session IDs appends to session_ids."""
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )
    result = call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-002",
            "working_directory": working_dir,
        },
    )
    assert "sessions=2" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    assert "sess-001" in data["plans"]["my-plan"]["session_ids"]
    assert "sess-002" in data["plans"]["my-plan"]["session_ids"]
    # Both sessions are bound to the same plan
    assert data["bindings"]["sess-001"]["plan_name"] == "my-plan"
    assert data["bindings"]["sess-002"]["plan_name"] == "my-plan"


def test_boulder_write_deduplicates_sessions(mcp_server, working_dir, tmp_git_root):
    """Calling boulder_write twice with the same session_id does not duplicate it."""
    for _ in range(2):
        call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": "/tmp/plan.md",
                "plan_name": "my-plan",
                "session_id": "sess-001",
                "working_directory": working_dir,
            },
        )
    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    assert data["plans"]["my-plan"]["session_ids"].count("sess-001") == 1


def test_boulder_write_preserves_started_at(mcp_server, working_dir, tmp_git_root):
    """Second boulder_write call preserves the original started_at timestamp."""
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )
    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    first_started_at = json.loads(path.read_text())["plans"]["my-plan"]["started_at"]

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/plan.md",
            "plan_name": "my-plan",
            "session_id": "sess-002",
            "working_directory": working_dir,
        },
    )
    second_started_at = json.loads(path.read_text())["plans"]["my-plan"]["started_at"]
    assert first_started_at == second_started_at


def test_boulder_write_session_id_from_env(mcp_server, working_dir, tmp_git_root):
    """boulder_write uses CLAUDE_CODE_SESSION_ID env var when session_id param is empty."""
    import unittest.mock as mock

    with mock.patch.dict(os.environ, {"CLAUDE_CODE_SESSION_ID": "env-sess-001"}):
        result = call_tool(
            mcp_server,
            "boulder_write",
            {
                "active_plan": "/tmp/plan.md",
                "plan_name": "env-plan",
                "session_id": "",
                "working_directory": working_dir,
            },
        )
    assert "env-plan" in result
    assert "sessions=1" in result

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    assert data["plans"]["env-plan"]["session_ids"] == ["env-sess-001"]
    assert data["bindings"]["env-sess-001"]["plan_name"] == "env-plan"


def test_boulder_write_two_plans_distinct_bindings(
    mcp_server, working_dir, tmp_git_root
):
    """Two different sessions registering two different plans get independent bindings."""
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/a.md",
            "plan_name": "plan-a",
            "session_id": "sess-a",
            "working_directory": working_dir,
        },
    )
    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": "/tmp/b.md",
            "plan_name": "plan-b",
            "session_id": "sess-b",
            "working_directory": working_dir,
        },
    )
    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    assert set(data["plans"]) == {"plan-a", "plan-b"}
    assert data["bindings"]["sess-a"]["plan_name"] == "plan-a"
    assert data["bindings"]["sess-b"]["plan_name"] == "plan-b"


# --- true parallel writers ---


def test_boulder_write_parallel_writers_no_lost_updates(working_dir, tmp_git_root):
    """N=50 interleaved writers across distinct plans/sessions lose zero plans/bindings."""
    n = 50
    barrier = threading.Barrier(n)
    errors = []

    def worker(i: int) -> None:
        try:
            barrier.wait(timeout=10)
            boulder_module._do_boulder_write(
                active_plan=f"/tmp/plan-{i}.md",
                plan_name=f"plan-{i}",
                session_id=f"sess-{i}",
                agent="sisyphus",
                worktree_path="",
                working_directory=working_dir,
            )
        except Exception as exc:  # pragma: no cover - surfaced via errors list
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"worker errors: {errors}"

    path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    data = json.loads(path.read_text())
    assert len(data["plans"]) == n
    assert len(data["bindings"]) == n
    for i in range(n):
        assert data["plans"][f"plan-{i}"]["active_plan"] == f"/tmp/plan-{i}.md"
        assert data["bindings"][f"sess-{i}"]["plan_name"] == f"plan-{i}"


# --- migration from a real old flat file ---


def test_migration_preserves_started_at_and_session_ids(
    mcp_server, working_dir, tmp_git_root
):
    """A real old flat boulder.json is lazily migrated on the next boulder_write,
    preserving started_at + session_ids into plans[name], and binding the writer."""
    old_flat = load_fixture("old-flat")
    boulder_path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    boulder_path.write_text(json.dumps(old_flat))

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": old_flat["active_plan"],
            "plan_name": old_flat["plan_name"],
            "session_id": "sess-legacy-1",
            "working_directory": working_dir,
        },
    )

    data = json.loads(boulder_path.read_text())
    assert "active_plan" not in data  # no longer flat
    plan_entry = data["plans"][old_flat["plan_name"]]
    assert plan_entry["started_at"] == old_flat["started_at"]
    assert set(plan_entry["session_ids"]) == set(old_flat["session_ids"])
    assert data["bindings"]["sess-legacy-1"]["plan_name"] == old_flat["plan_name"]


# --- resolver ladder (pure function, no MCP layer) ---


def test_resolver_binding_hit():
    data = load_fixture("two-plan")
    data["bindings"]["sess-x"] = {"plan_name": "plan-a", "bound_at": 1}
    result = _boulder_core.resolve_bound_plan(data, "sess-x")
    assert result["plan_name"] == "plan-a"
    assert result["active_plan"] == data["plans"]["plan-a"]["active_plan"]


def test_resolver_no_binding_single_plan_fallback():
    data = load_fixture("single-plan")
    result = _boulder_core.resolve_bound_plan(data, "unknown-session")
    assert result["plan_name"] == "plan-a"


def test_resolver_no_binding_multi_plan_most_recent():
    data = load_fixture("two-plan")
    result = _boulder_core.resolve_bound_plan(data, "unknown-session")
    # plan-b has the later started_at
    assert result["plan_name"] == "plan-b"


def test_resolver_empty_registry_returns_empty():
    result = _boulder_core.resolve_bound_plan({"plans": {}, "bindings": {}}, "sess-x")
    assert result == {}


def test_resolver_old_flat_schema_binding_via_single_plan():
    data = load_fixture("old-flat")
    result = _boulder_core.resolve_bound_plan(data, "unbound-session")
    assert result["plan_name"] == data["plan_name"]
    assert result["active_plan"] == data["active_plan"]


# --- pure-read proof ---


def test_resolver_never_writes_old_flat_fixture(tmp_path):
    """resolve_bound_plan on an old-flat fixture leaves the file byte-identical."""
    src = os.path.join(FIXTURES_DIR, "old-flat.json")
    with open(src) as f:
        before = f.read()
    data = json.loads(before)

    _boulder_core.resolve_bound_plan(data, "sess-legacy-1")

    with open(src) as f:
        after = f.read()
    assert before == after


# --- GC ---


def test_gc_prunes_stale_unbound_complete_plan(working_dir, tmp_git_root, tmp_path):
    """A stale, unbound, fully-checked plan is pruned on the next boulder_write."""
    complete_plan = tmp_path / "complete.md"
    complete_plan.write_text("- [x] 1. Done\n- [x] 2. Also done\n")

    old_started_at = "2020-01-01T00:00:00Z"  # far past GC_MAX_AGE_SECONDS
    state = {
        "plans": {
            "stale-complete": {
                "active_plan": str(complete_plan),
                "started_at": old_started_at,
                "session_ids": ["sess-old"],
                "agent": "sisyphus",
            }
        },
        "bindings": {},
    }
    boulder_path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    boulder_path.write_text(json.dumps(state))

    boulder_module._do_boulder_write(
        active_plan="/tmp/new.md",
        plan_name="new-plan",
        session_id="sess-new",
        agent="sisyphus",
        worktree_path="",
        working_directory=working_dir,
    )

    data = json.loads(boulder_path.read_text())
    assert "stale-complete" not in data["plans"]
    assert "new-plan" in data["plans"]


def test_gc_does_not_prune_live_bound_plan(working_dir, tmp_git_root, tmp_path):
    """A plan with a fresh (non-stale) binding is NEVER pruned, even if its
    started_at is old and its plan file is fully checked."""
    complete_plan = tmp_path / "complete.md"
    complete_plan.write_text("- [x] 1. Done\n")

    old_started_at = "2020-01-01T00:00:00Z"  # old enough to be prune-eligible by age
    recent_bound_at = int(
        boulder_module.time.time()
    )  # binding is fresh -> protects the plan
    state = {
        "plans": {
            "old-but-bound": {
                "active_plan": str(complete_plan),
                "started_at": old_started_at,
                "session_ids": ["sess-live"],
                "agent": "sisyphus",
            }
        },
        "bindings": {
            "sess-live": {"plan_name": "old-but-bound", "bound_at": recent_bound_at}
        },
    }
    boulder_path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    boulder_path.write_text(json.dumps(state))

    boulder_module._do_boulder_write(
        active_plan="/tmp/new.md",
        plan_name="new-plan",
        session_id="sess-new",
        agent="sisyphus",
        worktree_path="",
        working_directory=working_dir,
    )

    data = json.loads(boulder_path.read_text())
    assert "sess-live" in data["bindings"]
    assert "old-but-bound" in data["plans"]
    assert "new-plan" in data["plans"]


def test_gc_prunes_stale_binding(working_dir, tmp_git_root):
    """A stale binding (bound_at far in the past) is pruned on the next write."""
    state = {
        "plans": {
            "some-plan": {
                "active_plan": "/tmp/some.md",
                "started_at": boulder_module._now_iso(),
                "session_ids": ["sess-stale"],
                "agent": "sisyphus",
            }
        },
        "bindings": {"sess-stale": {"plan_name": "some-plan", "bound_at": 1}},
    }
    boulder_path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    boulder_path.write_text(json.dumps(state))

    boulder_module._do_boulder_write(
        active_plan="/tmp/new.md",
        plan_name="new-plan",
        session_id="sess-new",
        agent="sisyphus",
        worktree_path="",
        working_directory=working_dir,
    )

    data = json.loads(boulder_path.read_text())
    assert "sess-stale" not in data["bindings"]
    assert "sess-new" in data["bindings"]


# --- boulder_resolve.py CLI shim ---


@pytest.mark.parametrize(
    "fixture_name,session_id",
    [
        ("old-flat", "sess-legacy-1"),
        ("single-plan", "no-such-session"),
        ("two-plan", "no-such-session"),
    ],
)
def test_boulder_resolve_cli_matches_python_resolver(
    tmp_git_root, fixture_name, session_id
):
    data = load_fixture(fixture_name)
    boulder_path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    boulder_path.write_text(json.dumps(data))

    expected = _boulder_core.resolve_bound_plan(data, session_id)

    script = os.path.join(
        os.path.dirname(__file__), "..", "tools", "boulder_resolve.py"
    )
    result = subprocess.run(
        [sys.executable, script, session_id, str(tmp_git_root)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == expected


def test_boulder_resolve_cli_corrupt_file_prints_empty_object(tmp_git_root):
    boulder_path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    boulder_path.write_text(load_fixture_raw("corrupt"))

    script = os.path.join(
        os.path.dirname(__file__), "..", "tools", "boulder_resolve.py"
    )
    result = subprocess.run(
        [sys.executable, script, "any-session", str(tmp_git_root)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == {}


def test_boulder_resolve_cli_half_written_file_prints_empty_object(tmp_git_root):
    boulder_path = tmp_git_root / ".omca" / "state" / BOULDER_FILE
    boulder_path.write_text(load_fixture_raw("half-written"))

    script = os.path.join(
        os.path.dirname(__file__), "..", "tools", "boulder_resolve.py"
    )
    result = subprocess.run(
        [sys.executable, script, "any-session", str(tmp_git_root)],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == {}


# --- boulder_progress: checkbox counting ---


def test_boulder_progress_reads_plan_checkboxes(mcp_server, working_dir, tmp_path):
    """boulder_progress parses plan file checkboxes and returns task counts."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(
        "# My Plan\n\n- [x] 1. Task one done\n- [ ] 2. Task two pending\n- [ ] 3. Task three pending\n"
    )

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "progress-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"session_id": "sess-001", "working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["total"] == 3
    assert data["completed"] == 1
    assert data["remaining"] == 2
    assert data["is_complete"] is False
    assert data["plan_path"] == str(plan_file)


def test_boulder_progress_by_plan_name(mcp_server, working_dir, tmp_path):
    """boulder_progress resolves via explicit plan_name, bypassing session resolution."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [x] 1. Done\n- [ ] 2. Pending\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "named-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"plan_name": "named-plan", "working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["total"] == 2
    assert data["plan_path"] == str(plan_file)


def test_boulder_progress_exact_regex_unnumbered_ignored(
    mcp_server, working_dir, tmp_path
):
    """boulder_progress counts only lines matching ^- \\[([ x])\\] \\d+\\. (numbered checkboxes)."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text(
        "# Plan\n\n"
        "- [x] 1. Numbered done\n"
        "- [ ] 2. Numbered pending\n"
        "- [x] Review docs\n"  # unnumbered — must NOT be counted
        "- [ ] Notify stakeholders\n"  # unnumbered — must NOT be counted
    )

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "regex-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"session_id": "sess-001", "working_directory": working_dir},
    )
    data = json.loads(result)
    # Only the 2 numbered tasks count
    assert data["total"] == 2
    assert data["completed"] == 1
    assert data["remaining"] == 1


def test_boulder_progress_all_complete(mcp_server, working_dir, tmp_path):
    """boulder_progress reports is_complete=True when all numbered checkboxes are checked."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [x] 1. Task one done\n- [x] 2. Task two done\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "done-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"session_id": "sess-001", "working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["total"] == 2
    assert data["completed"] == 2
    assert data["remaining"] == 0
    assert data["is_complete"] is True


def test_boulder_progress_empty_plan(mcp_server, working_dir, tmp_path):
    """boulder_progress on a plan with no numbered checkboxes returns total=0, is_complete=False."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("# Empty plan\n\nNo tasks here.\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "empty-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"session_id": "sess-001", "working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["total"] == 0
    assert data["is_complete"] is False


def test_boulder_progress_explicit_plan_path(mcp_server, working_dir, tmp_path):
    """boulder_progress accepts an explicit plan_path without requiring boulder state."""
    plan_file = tmp_path / "standalone.md"
    plan_file.write_text("- [x] 1. Done\n- [ ] 2. Pending\n")

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"plan_path": str(plan_file), "working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["total"] == 2
    assert data["completed"] == 1
    assert data["plan_path"] == str(plan_file)


def test_boulder_progress_missing_plan_returns_structured_error(
    mcp_server, working_dir, tmp_path
):
    """boulder_progress returns structured JSON error when plan file is deleted."""
    plan_file = tmp_path / "plan.md"
    plan_file.write_text("- [ ] 1. Task one\n")

    call_tool(
        mcp_server,
        "boulder_write",
        {
            "active_plan": str(plan_file),
            "plan_name": "ghost-plan",
            "session_id": "sess-001",
            "working_directory": working_dir,
        },
    )

    plan_file.unlink()

    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"session_id": "sess-001", "working_directory": working_dir},
    )
    data = json.loads(result)
    assert data["error"] is True
    assert data["plan_missing"] is True
    assert "plan.md" in data["plan_path"]


def test_boulder_progress_no_active_plan_returns_message(mcp_server, working_dir):
    """boulder_progress with no boulder state returns a plain-string message."""
    result = call_tool(
        mcp_server,
        "boulder_progress",
        {"working_directory": working_dir},
    )
    assert "No active plan" in result
