"""Tests for GitLab MR rendering (pr.kind, v2.1.234) and main-line width clamping.

pr.kind == "mr" must render `!N` to agree with the client's own `MR !N` badge;
absence keeps the GitHub `#N` form. Separately, every line render() emits must
fit the terminal width, since a wrapped statusline pushes the prompt off-screen.
"""

from __future__ import annotations

import re
from typing import cast

import pytest

from statusline.core import _compose_repo_pr, _visible_truncate, build_glyphs, render
from statusline.types import StatuslinePayload


def _strip_ansi(s: str) -> str:
    """Remove SGR and OSC 8 sequences, keeping the link's visible text."""
    s = re.sub(r"\x1b\]8;;[^\x07]*\x07([^\x1b]*)\x1b\]8;;\x07", lambda m: m.group(1), s)
    s = re.sub(r"\x1b\]8;;[^\x07]*\x07", "", s)
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


def _p(d: dict) -> StatuslinePayload:
    return cast(StatuslinePayload, d)


class TestPrKind:
    def test_gitlab_mr_renders_bang(self) -> None:
        data = {
            "workspace": {"repo": {"owner": "acme", "name": "api"}},
            "pr": {"number": 1234, "kind": "mr"},
        }
        plain = _strip_ansi(_compose_repo_pr(_p(data), build_glyphs(False), False))
        assert "!1234" in plain
        assert "#1234" not in plain

    def test_absent_kind_renders_hash(self) -> None:
        data = {
            "workspace": {"repo": {"owner": "acme", "name": "api"}},
            "pr": {"number": 1234},
        }
        plain = _strip_ansi(_compose_repo_pr(_p(data), build_glyphs(False), False))
        assert "#1234" in plain

    def test_unknown_kind_renders_hash(self) -> None:
        """Only the documented "mr" value switches the sigil."""
        data = {
            "workspace": {"repo": {"name": "api"}},
            "pr": {"number": 7, "kind": "pr"},
        }
        plain = _strip_ansi(_compose_repo_pr(_p(data), build_glyphs(False), False))
        assert "#7" in plain

    def test_mr_sigil_survives_osc8_link(self) -> None:
        data = {
            "workspace": {"repo": {"name": "api"}},
            "pr": {
                "number": 9,
                "kind": "mr",
                "url": "https://gitlab.com/acme/api/-/merge_requests/9",
            },
        }
        result = _compose_repo_pr(_p(data), build_glyphs(False), False)
        assert "\x1b]8;;" in result
        assert "!9" in _strip_ansi(result)


class TestVisibleTruncate:
    def test_ansi_codes_are_not_counted(self) -> None:
        s = "\x1b[31mabcdef\x1b[0m"
        assert _strip_ansi(_visible_truncate(s, 3)) == "abc"

    def test_osc8_link_is_closed_when_cut_mid_link(self) -> None:
        s = "\x1b]8;;https://example.com\x07linktext\x1b]8;;\x07tail"
        out = _visible_truncate(s, 4)
        assert out.count("\x1b]8;;\x07") == 1
        assert _strip_ansi(out) == "link"

    def test_short_line_is_unchanged_apart_from_reset(self) -> None:
        assert _strip_ansi(_visible_truncate("hi", 40)) == "hi"


class TestMainLineWidth:
    def test_no_rendered_line_exceeds_terminal_width(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path
    ) -> None:
        monkeypatch.setenv("COLUMNS", "60")
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        data = {
            "model": {"display_name": "Claude Opus With A Very Long Display Name"},
            "workspace": {
                "project_dir": str(tmp_path / ("deeply" * 10)),
                "repo": {"owner": "a" * 40, "name": "b" * 40},
            },
            "pr": {"number": 1234, "kind": "mr", "review_state": "approved"},
            "session_name": "s" * 60,
            "context_window": {"context_window_size": 200000, "used_percentage": 50.0},
            "cost": {"total_cost_usd": 1.23, "total_duration_ms": 90000},
            "rate_limits": {"five_hour": {"used_percentage": 10.0}},
            "output_style": {"name": "some-other-style"},
            "version": "2.1.245",
        }
        result = render(_p(data), {"is_git": "0"})
        assert "\n" in result  # multi-line path, so every branch is covered
        for line in result.split("\n"):
            assert len(_strip_ansi(line)) <= 60

    def test_single_line_path_is_clamped(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("COLUMNS", "30")
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        data = {
            "model": {"display_name": "M" * 80},
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {},
        }
        result = render(_p(data), {"is_git": "0"})
        assert "\n" not in result
        assert len(_strip_ansi(result)) <= 30
