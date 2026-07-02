"""Tests for the SessionStart boulder GC shim (boulder_gc.py + gc_prune_unbound)."""

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools._boulder_core import gc_prune_unbound, normalize, plan_is_complete

GC_SHIM = os.path.join(os.path.dirname(__file__), "..", "tools", "boulder_gc.py")


def _plan_entry(path: str) -> dict:
    return {"active_plan": path, "started_at": "2026-01-01T00:00:00Z"}


def _write_plan(tmp_path, name: str, content: str) -> str:
    p = tmp_path / name
    p.write_text(content)
    return str(p)


COMPLETE = "- [x] 1. one\n- [x] 2. two\n"
INCOMPLETE = "- [x] 1. one\n- [ ] 2. two\n"


# ---------------------------------------------------------------------------
# plan_is_complete
# ---------------------------------------------------------------------------


class TestPlanIsComplete:
    def test_all_checked_is_complete(self, tmp_path) -> None:
        assert plan_is_complete(_write_plan(tmp_path, "p.md", COMPLETE)) is True

    def test_open_task_is_incomplete(self, tmp_path) -> None:
        assert plan_is_complete(_write_plan(tmp_path, "p.md", INCOMPLETE)) is False

    def test_no_checkboxes_is_incomplete(self, tmp_path) -> None:
        assert plan_is_complete(_write_plan(tmp_path, "p.md", "# prose only")) is False

    def test_missing_file_is_incomplete(self, tmp_path) -> None:
        assert plan_is_complete(str(tmp_path / "ghost.md")) is False

    def test_empty_path_is_incomplete(self) -> None:
        assert plan_is_complete("") is False


# ---------------------------------------------------------------------------
# gc_prune_unbound (pure registry function)
# ---------------------------------------------------------------------------


class TestGcPruneUnbound:
    def test_prunes_unbound_complete_plan(self, tmp_path) -> None:
        registry = {
            "plans": {"done": _plan_entry(_write_plan(tmp_path, "d.md", COMPLETE))},
            "bindings": {},
        }
        pruned = gc_prune_unbound(registry)
        assert pruned["pruned_plans"] == ["done"]
        assert registry["plans"] == {}

    def test_keeps_bound_complete_plan(self, tmp_path) -> None:
        registry = {
            "plans": {"done": _plan_entry(_write_plan(tmp_path, "d.md", COMPLETE))},
            "bindings": {"sess-1": {"plan_name": "done", "bound_at": 1}},
        }
        pruned = gc_prune_unbound(registry)
        assert pruned["pruned_plans"] == []
        assert "done" in registry["plans"]

    def test_keeps_unbound_incomplete_plan(self, tmp_path) -> None:
        registry = {
            "plans": {"wip": _plan_entry(_write_plan(tmp_path, "w.md", INCOMPLETE))},
            "bindings": {},
        }
        pruned = gc_prune_unbound(registry)
        assert pruned["pruned_plans"] == []
        assert "wip" in registry["plans"]

    def test_prunes_unbound_missing_file_plan(self, tmp_path) -> None:
        registry = {
            "plans": {"ghost": _plan_entry(str(tmp_path / "gone.md"))},
            "bindings": {},
        }
        pruned = gc_prune_unbound(registry)
        assert pruned["pruned_plans"] == ["ghost"]

    def test_prunes_plan_with_empty_path(self) -> None:
        registry = {"plans": {"bad": {"active_plan": ""}}, "bindings": {}}
        pruned = gc_prune_unbound(registry)
        assert pruned["pruned_plans"] == ["bad"]

    def test_drops_orphan_binding_then_prunes_its_plan_target(self, tmp_path) -> None:
        """A binding to a nonexistent plan is removed and cannot protect anything."""
        registry = {
            "plans": {"done": _plan_entry(_write_plan(tmp_path, "d.md", COMPLETE))},
            "bindings": {"sess-x": {"plan_name": "no-such-plan", "bound_at": 1}},
        }
        pruned = gc_prune_unbound(registry)
        assert pruned["pruned_bindings"] == ["sess-x"]
        assert pruned["pruned_plans"] == ["done"]


# ---------------------------------------------------------------------------
# boulder_gc.py shim (subprocess, like boulder_resolve.py is exercised)
# ---------------------------------------------------------------------------


def _run_shim(workdir: str) -> dict:
    out = subprocess.run(
        [sys.executable, GC_SHIM, workdir],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def _state_dir(tmp_path) -> str:
    d = tmp_path / ".omca" / "state"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)


class TestBoulderGcShim:
    def test_no_boulder_file_is_noop(self, tmp_path) -> None:
        _state_dir(tmp_path)
        assert _run_shim(str(tmp_path)) == {}

    def test_prunes_completed_unbound_and_persists(self, tmp_path) -> None:
        state = _state_dir(tmp_path)
        plan = _write_plan(tmp_path, "done.md", COMPLETE)
        registry = {"plans": {"done": _plan_entry(plan)}, "bindings": {}}
        boulder = os.path.join(state, "boulder.json")
        with open(boulder, "w") as f:
            json.dump(registry, f)

        summary = _run_shim(str(tmp_path))
        assert summary["pruned_plans"] == ["done"]
        with open(boulder) as f:
            assert json.load(f) == {"plans": {}, "bindings": {}}

    def test_flat_schema_completed_plan_pruned_to_empty_registry(
        self, tmp_path
    ) -> None:
        """The user-visible bug: an old flat boulder.json holding a finished
        plan must be cleaned, not resurrected by resolver fallbacks."""
        state = _state_dir(tmp_path)
        plan = _write_plan(tmp_path, "old.md", COMPLETE)
        flat = {"active_plan": plan, "plan_name": "old-plan", "agent": "sisyphus"}
        boulder = os.path.join(state, "boulder.json")
        with open(boulder, "w") as f:
            json.dump(flat, f)

        summary = _run_shim(str(tmp_path))
        assert summary["pruned_plans"] == ["old-plan"]
        with open(boulder) as f:
            assert json.load(f) == {"plans": {}, "bindings": {}}

    def test_flat_schema_incomplete_plan_left_untouched(self, tmp_path) -> None:
        """Incomplete unbound work is resumable — the file stays byte-identical."""
        state = _state_dir(tmp_path)
        plan = _write_plan(tmp_path, "wip.md", INCOMPLETE)
        flat = {"active_plan": plan, "plan_name": "wip-plan"}
        boulder = os.path.join(state, "boulder.json")
        with open(boulder, "w") as f:
            json.dump(flat, f)
        with open(boulder) as f:
            before = f.read()

        summary = _run_shim(str(tmp_path))
        assert summary == {"pruned_plans": [], "pruned_bindings": []}
        with open(boulder) as f:
            assert f.read() == before

    def test_bound_plan_survives(self, tmp_path) -> None:
        state = _state_dir(tmp_path)
        plan = _write_plan(tmp_path, "done.md", COMPLETE)
        registry = {
            "plans": {"done": _plan_entry(plan)},
            "bindings": {"sess-live": {"plan_name": "done", "bound_at": 1}},
        }
        boulder = os.path.join(state, "boulder.json")
        with open(boulder, "w") as f:
            json.dump(registry, f)

        summary = _run_shim(str(tmp_path))
        assert summary == {"pruned_plans": [], "pruned_bindings": []}
        with open(boulder) as f:
            assert "done" in json.load(f)["plans"]

    def test_corrupt_boulder_exits_zero(self, tmp_path) -> None:
        state = _state_dir(tmp_path)
        with open(os.path.join(state, "boulder.json"), "w") as f:
            f.write("{corrupt!!!")
        # _read_json fail-softs to {} -> normalize -> nothing to prune
        summary = _run_shim(str(tmp_path))
        assert summary == {"pruned_plans": [], "pruned_bindings": []}

    def test_gc_result_matches_pure_function(self, tmp_path) -> None:
        """Shim and in-process function agree on the same registry."""
        state = _state_dir(tmp_path)
        done = _write_plan(tmp_path, "d.md", COMPLETE)
        wip = _write_plan(tmp_path, "w.md", INCOMPLETE)
        registry = {
            "plans": {"done": _plan_entry(done), "wip": _plan_entry(wip)},
            "bindings": {},
        }
        with open(os.path.join(state, "boulder.json"), "w") as f:
            json.dump(registry, f)

        expected = gc_prune_unbound(normalize(json.loads(json.dumps(registry))))
        summary = _run_shim(str(tmp_path))
        assert summary == expected
