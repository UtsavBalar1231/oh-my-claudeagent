"""Tests for statusline.subagent (per-subagent status line renderer)."""

from __future__ import annotations

import io
import json
import pathlib

import pytest

from statusline.core import build_glyphs
from statusline.subagent import (
    _load_models,
    _render_row,
    _resolve_model,
    _visible_truncate,
    main,
)


class TestLoadModels:
    def test_no_state_file_returns_empty(self, tmp_path: pathlib.Path) -> None:
        assert _load_models(str(tmp_path)) == {}

    def test_empty_cwd_returns_empty(self) -> None:
        assert _load_models("") == {}

    def test_loads_valid_map(self, tmp_path: pathlib.Path) -> None:
        state_dir = tmp_path / ".omca" / "state"
        state_dir.mkdir(parents=True)
        models = {"agent-1": {"agent_type": "executor", "model": "Sonnet 5"}}
        (state_dir / "subagent-models.json").write_text(json.dumps(models))
        assert _load_models(str(tmp_path)) == models

    def test_malformed_json_returns_empty(self, tmp_path: pathlib.Path) -> None:
        state_dir = tmp_path / ".omca" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "subagent-models.json").write_text("{not valid!!!")
        assert _load_models(str(tmp_path)) == {}

    def test_non_dict_json_returns_empty(self, tmp_path: pathlib.Path) -> None:
        state_dir = tmp_path / ".omca" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "subagent-models.json").write_text("[1, 2]")
        assert _load_models(str(tmp_path)) == {}


class TestResolveModel:
    def test_id_join_primary(self) -> None:
        models = {"agent-1": {"agent_type": "executor", "model": "Sonnet 5"}}
        task = {"id": "agent-1", "name": "oh-my-claudeagent:executor"}
        assert _resolve_model(task, models) == "Sonnet 5"

    def test_falls_back_to_name_match(self) -> None:
        models = {"agent-xyz": {"agent_type": "oracle", "model": "Opus 4.8"}}
        task = {"id": "mismatched-id", "name": "oracle"}
        assert _resolve_model(task, models) == "Opus 4.8"

    def test_no_match_returns_empty(self) -> None:
        models = {"agent-1": {"agent_type": "executor", "model": "Sonnet 5"}}
        task = {"id": "other-id", "name": "hephaestus"}
        assert _resolve_model(task, models) == ""

    def test_empty_models_returns_empty(self) -> None:
        assert _resolve_model({"id": "a", "name": "executor"}, {}) == ""


class TestVisibleTruncate:
    def test_zero_width_returns_empty(self) -> None:
        assert _visible_truncate("hello", 0) == ""

    def test_no_truncation_needed(self) -> None:
        result = _visible_truncate("hi", 10)
        assert "hi" in result

    def test_truncates_visible_chars_ignoring_ansi(self) -> None:
        s = "\033[31mhello world\033[0m"
        result = _visible_truncate(s, 5)
        # ANSI codes pass through untouched; only 5 visible chars kept.
        assert "hello" in result
        assert "world" not in result


class TestRenderRow:
    def _glyphs(self) -> dict:
        return build_glyphs(False)

    def test_row_with_model(self) -> None:
        task = {
            "id": "agent-1",
            "name": "oh-my-claudeagent:executor",
            "status": "in_progress",
            "tokenCount": 15234,
        }
        models = {"agent-1": {"agent_type": "executor", "model": "Sonnet 5"}}
        row = _render_row(task, models, self._glyphs(), False, 80)
        assert "executor" in row
        assert "Sonnet 5" in row
        assert "in_progress" in row
        assert "15.2k tok" in row

    def test_row_without_model_no_crash(self) -> None:
        task = {
            "id": "agent-2",
            "name": "oh-my-claudeagent:explore",
            "status": "completed",
        }
        row = _render_row(task, {}, self._glyphs(), False, 80)
        assert "explore" in row
        assert "completed" in row

    def test_strips_namespace_prefix(self) -> None:
        task = {"id": "a", "name": "oh-my-claudeagent:hephaestus", "status": "running"}
        row = _render_row(task, {}, self._glyphs(), False, 80)
        assert "oh-my-claudeagent:" not in row


class TestMainStdinContract:
    def test_two_task_payload_with_model_map(
        self,
        tmp_path: pathlib.Path,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        state_dir = tmp_path / ".omca" / "state"
        state_dir.mkdir(parents=True)
        models = {
            "agent-1": {"agent_type": "executor", "model": "Sonnet 5"},
            "agent-2": {"agent_type": "oracle", "model": "Opus 4.8"},
        }
        (state_dir / "subagent-models.json").write_text(json.dumps(models))

        payload = {
            "tasks": [
                {
                    "id": "agent-1",
                    "name": "oh-my-claudeagent:executor",
                    "status": "in_progress",
                    "cwd": str(tmp_path),
                },
                {
                    "id": "agent-2",
                    "name": "oh-my-claudeagent:oracle",
                    "status": "completed",
                    "cwd": str(tmp_path),
                },
            ],
            "columns": 80,
        }
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
        main()

        out = capsys.readouterr().out.strip().splitlines()
        assert len(out) == 2
        rows = [json.loads(line) for line in out]
        assert rows[0]["id"] == "agent-1"
        assert "Sonnet 5" in rows[0]["content"]
        assert rows[1]["id"] == "agent-2"
        assert "Opus 4.8" in rows[1]["content"]

    def test_model_resolved_via_top_level_cwd(
        self,
        tmp_path: pathlib.Path,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Production path: the SubagentStart capture writes ONE state file at the
        # main session root; tasks carry no per-task cwd. The renderer must locate
        # it via the top-level payload cwd (regression: previously used task.cwd
        # only, so the model never resolved for real payloads).
        state_dir = tmp_path / ".omca" / "state"
        state_dir.mkdir(parents=True)
        (state_dir / "subagent-models.json").write_text(
            json.dumps({"agent-1": {"agent_type": "executor", "model": "Sonnet"}})
        )
        payload = {
            "cwd": str(tmp_path),
            "tasks": [
                {
                    "id": "agent-1",
                    "name": "oh-my-claudeagent:executor",
                    "status": "running",
                }
            ],
            "columns": 80,
        }
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
        main()
        rows = [
            json.loads(line) for line in capsys.readouterr().out.strip().splitlines()
        ]
        assert len(rows) == 1
        assert "Sonnet" in rows[0]["content"]

    def test_task_with_no_map_entry_no_crash(
        self,
        tmp_path: pathlib.Path,
        capsys: pytest.CaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        payload = {
            "tasks": [
                {
                    "id": "unmapped",
                    "name": "oh-my-claudeagent:explore",
                    "status": "running",
                    "cwd": str(tmp_path),
                }
            ]
        }
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
        main()

        out = capsys.readouterr().out.strip().splitlines()
        assert len(out) == 1
        row = json.loads(out[0])
        assert row["id"] == "unmapped"
        assert "explore" in row["content"]

    def test_absent_state_file_no_crash(
        self, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        payload = {
            "tasks": [
                {"id": "a", "name": "oh-my-claudeagent:hephaestus", "status": "running"}
            ]
        }
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
        main()

        out = capsys.readouterr().out.strip().splitlines()
        assert len(out) == 1

    def test_malformed_stdin_no_crash(
        self, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not valid json"))
        main()

        out = capsys.readouterr().out
        assert out == ""

    def test_empty_tasks_no_crash(
        self, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"tasks": []})))
        main()

        out = capsys.readouterr().out
        assert out == ""
