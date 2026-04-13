"""Tests for statusline.core rendering functions."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from statusline.core import (
    DIM,
    GREEN,
    RED,
    RST,
    YELLOW,
    _compose_line1,
    _compose_line2,
    _compose_line3,
    _extract_rate_limits,
    _format_duration,
    _format_reset_time,
    _format_tokens,
    _render_bar,
    _render_context_bar,
    _threshold_color,
    build_glyphs,
    detect_nerd_font,
    render,
)

# ---------------------------------------------------------------------------
# detect_nerd_font
# ---------------------------------------------------------------------------


class TestDetectNerdFont:
    def test_explicit_one(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "1")
        assert detect_nerd_font() is True

    def test_explicit_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        assert detect_nerd_font() is False

    def test_fallback_nerd_font_var_one(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CLAUDE_STATUSLINE_NERD_FONT", raising=False)
        monkeypatch.setenv("NERD_FONT", "1")
        assert detect_nerd_font() is True

    def test_fallback_nerd_font_var_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CLAUDE_STATUSLINE_NERD_FONT", raising=False)
        monkeypatch.setenv("NERD_FONT", "0")
        assert detect_nerd_font() is False

    def test_default_true_when_no_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CLAUDE_STATUSLINE_NERD_FONT", raising=False)
        monkeypatch.delenv("NERD_FONT", raising=False)
        assert detect_nerd_font() is True

    def test_whitespace_around_value(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", " 1 ")
        assert detect_nerd_font() is True


# ---------------------------------------------------------------------------
# _threshold_color
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("pct", "expected"),
    [
        (0.0, GREEN),
        (59.9, GREEN),
        (60.0, YELLOW),
        (84.9, YELLOW),
        (85.0, RED),
        (100.0, RED),
    ],
)
def test_threshold_color(pct: float, expected: str) -> None:
    assert _threshold_color(pct) == expected


# ---------------------------------------------------------------------------
# _render_bar
# ---------------------------------------------------------------------------


class TestRenderBar:
    def test_zero_percent(self) -> None:
        bar = _render_bar(0.0, bar_width=10, color=GREEN)
        # 0 filled blocks, 10 empty blocks
        assert bar.count(f"{DIM}\u25b1{RST}") == 10
        assert f"{GREEN}\u25b0{RST}" not in bar

    def test_hundred_percent(self) -> None:
        bar = _render_bar(100.0, bar_width=10, color=RED)
        assert bar.count(f"{RED}\u25b0{RST}") == 10
        assert f"{DIM}\u25b1{RST}" not in bar

    def test_fifty_percent(self) -> None:
        bar = _render_bar(50.0, bar_width=10, color=GREEN)
        assert bar.count(f"{GREEN}\u25b0{RST}") == 5
        assert bar.count(f"{DIM}\u25b1{RST}") == 5

    def test_clamping_below_zero(self) -> None:
        bar = _render_bar(-10.0, bar_width=10, color=GREEN)
        assert bar.count(f"{DIM}\u25b1{RST}") == 10

    def test_clamping_above_hundred(self) -> None:
        bar = _render_bar(110.0, bar_width=10, color=RED)
        assert bar.count(f"{RED}\u25b0{RST}") == 10

    def test_custom_width(self) -> None:
        bar = _render_bar(50.0, bar_width=20, color=GREEN)
        assert bar.count(f"{GREEN}\u25b0{RST}") == 10
        assert bar.count(f"{DIM}\u25b1{RST}") == 10


# ---------------------------------------------------------------------------
# _render_context_bar
# ---------------------------------------------------------------------------


class TestRenderContextBar:
    def test_explicit_pct(self) -> None:
        ctx = {"context_window_size": 200000}
        bar = _render_context_bar(50.0, ctx, False, bar_width=10)
        assert "50%" in bar
        assert "200k" in bar

    def test_from_current_usage(self) -> None:
        ctx = {
            "context_window_size": 200000,
            "current_usage": {
                "input_tokens": 100000,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            },
        }
        bar = _render_context_bar(None, ctx, False, bar_width=10)
        assert "50%" in bar

    def test_waiting_placeholder_when_no_data(self) -> None:
        ctx = {"context_window_size": 200000}
        bar = _render_context_bar(None, ctx, False, bar_width=10)
        assert "waiting" in bar

    def test_exceeds_200k_shows_warning(self) -> None:
        ctx = {"context_window_size": 200000}
        bar = _render_context_bar(90.0, ctx, True, bar_width=10)
        assert "!" in bar

    def test_exceeds_200k_no_warning_on_1m_window(self) -> None:
        ctx = {"context_window_size": 1000000}
        bar = _render_context_bar(90.0, ctx, True, bar_width=10)
        # No warning on 1M windows
        assert "1M" in bar
        # Warning only when ctx_size <= 200000
        # strip ANSI for easy check
        import re

        plain = re.sub(r"\033\[[^m]+m|\033\].*?\a", "", bar)
        assert "!" not in plain

    def test_size_label_200k(self) -> None:
        ctx = {"context_window_size": 200000}
        bar = _render_context_bar(10.0, ctx, False)
        assert "200k" in bar

    def test_size_label_1m(self) -> None:
        ctx = {"context_window_size": 1000000}
        bar = _render_context_bar(10.0, ctx, False)
        assert "1M" in bar

    def test_default_context_window_size(self) -> None:
        # No context_window_size key -> defaults to 200000
        ctx: dict = {}
        bar = _render_context_bar(10.0, ctx, False)
        assert "200k" in bar


# ---------------------------------------------------------------------------
# _format_duration
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (None, "0m 0s"),
        (0, "0m 0s"),
        (61000, "1m 1s"),
        (3600000, "60m 0s"),
        (90000, "1m 30s"),
    ],
)
def test_format_duration(ms: int | None, expected: str) -> None:
    assert _format_duration(ms) == expected


# ---------------------------------------------------------------------------
# _format_reset_time
# ---------------------------------------------------------------------------


class TestFormatResetTime:
    def test_none_returns_empty(self) -> None:
        assert _format_reset_time(None) == ""

    def test_unix_epoch_same_day(self) -> None:
        from datetime import datetime, timezone

        # Use a fixed timestamp and mock now() to same day
        fixed_ts = datetime(2026, 4, 11, 17, 0, 0, tzinfo=timezone.utc).timestamp()
        now_dt = datetime(2026, 4, 11, 12, 0, 0, tzinfo=timezone.utc)

        with patch("statusline.core.datetime") as mock_dt:
            mock_dt.fromtimestamp.return_value = datetime(
                2026, 4, 11, 17, 0, 0, tzinfo=timezone.utc
            ).astimezone()
            mock_dt.fromisoformat.side_effect = datetime.fromisoformat
            mock_dt.now.return_value = now_dt.astimezone()
            result = _format_reset_time(int(fixed_ts))
        # Should not contain day prefix
        assert result != ""
        # Should be a short time string like "5pm"
        assert any(c.isdigit() for c in result)

    def test_iso_string_input(self) -> None:
        from datetime import datetime, timezone

        iso = "2026-04-11T17:00:00Z"
        now_dt = datetime(2026, 4, 11, 12, 0, 0, tzinfo=timezone.utc)

        with patch("statusline.core.datetime") as mock_dt:
            local_result = datetime.fromisoformat(
                iso.replace("Z", "+00:00")
            ).astimezone()
            mock_dt.fromisoformat.return_value = local_result
            mock_dt.fromtimestamp.side_effect = datetime.fromtimestamp
            mock_dt.now.return_value = now_dt.astimezone()
            result = _format_reset_time(iso)
        assert result != ""

    def test_none_equivalent_returns_empty(self) -> None:
        assert _format_reset_time(None) == ""

    def test_different_day_includes_day_prefix(self) -> None:
        from datetime import datetime, timezone

        # Timestamp on a Thursday, "now" is Saturday
        thursday_ts = datetime(2026, 4, 9, 17, 0, 0, tzinfo=timezone.utc).timestamp()
        now_dt = datetime(2026, 4, 11, 12, 0, 0, tzinfo=timezone.utc)

        with patch("statusline.core.datetime") as mock_dt:
            local_thursday = datetime(
                2026, 4, 9, 17, 0, 0, tzinfo=timezone.utc
            ).astimezone()
            mock_dt.fromtimestamp.return_value = local_thursday
            mock_dt.fromisoformat.side_effect = datetime.fromisoformat
            mock_dt.now.return_value = now_dt.astimezone()
            result = _format_reset_time(int(thursday_ts))

        # Should include day abbreviation prefix (e.g. "thu")
        assert result != ""
        # Should contain a space (day + time)
        assert " " in result


# ---------------------------------------------------------------------------
# _extract_rate_limits
# ---------------------------------------------------------------------------


class TestExtractRateLimits:
    def test_no_rate_limits_key(self) -> None:
        assert _extract_rate_limits({}) is None

    def test_empty_rate_limits(self) -> None:
        # rate_limits present but empty -> falsy
        assert _extract_rate_limits({"rate_limits": {}}) is None

    def test_both_windows(self) -> None:
        data = {
            "rate_limits": {
                "five_hour": {"used_percentage": 45.0, "resets_at": 1000},
                "seven_day": {"used_percentage": 80.0, "resets_at": 2000},
            }
        }
        result = _extract_rate_limits(data)
        assert result is not None
        assert result["five_hour_pct"] == 45.0
        assert result["seven_day_pct"] == 80.0
        assert result["five_hour_resets_at"] == 1000
        assert result["seven_day_resets_at"] == 2000

    def test_one_window_missing(self) -> None:
        data = {
            "rate_limits": {
                "five_hour": {"used_percentage": 45.0, "resets_at": 1000},
            }
        }
        result = _extract_rate_limits(data)
        assert result is not None
        assert result["five_hour_pct"] == 45.0
        assert result["seven_day_pct"] is None

    def test_all_values_none_returns_none(self) -> None:
        data = {
            "rate_limits": {
                "five_hour": {},
                "seven_day": {},
            }
        }
        result = _extract_rate_limits(data)
        assert result is None


# ---------------------------------------------------------------------------
# _compose_line1
# ---------------------------------------------------------------------------


class TestComposeLine1:
    def _glyphs(self) -> dict:
        return build_glyphs(False)  # ASCII for easier string checks

    def test_minimal_payload(self, git_info_empty: dict) -> None:
        data = {"model": {"display_name": "claude-3-5-sonnet"}}
        glyphs = self._glyphs()
        line, has_extra = _compose_line1(data, glyphs, git_info_empty)
        assert "claude-3-5-sonnet" in line
        assert has_extra is False

    def test_with_git_branch(self, git_info_active: dict) -> None:
        data = {
            "model": {"display_name": "claude-opus"},
            "workspace": {"project_dir": "/home/user/myrepo"},
        }
        glyphs = self._glyphs()
        line, has_extra = _compose_line1(data, glyphs, git_info_active)
        assert "main" in line
        assert has_extra is True

    def test_with_agent(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude-opus"},
            "agent": {"name": "my-agent"},
        }
        glyphs = self._glyphs()
        line, has_extra = _compose_line1(data, glyphs, git_info_empty)
        assert "my-agent" in line
        assert has_extra is True

    def test_with_worktree(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude-opus"},
            "worktree": {
                "name": "feature-branch",
                "branch": "feature/x",
                "original_branch": "main",
            },
        }
        glyphs = self._glyphs()
        line, has_extra = _compose_line1(data, glyphs, git_info_empty)
        assert "feature-branch" in line
        assert "main" in line
        assert has_extra is True

    def test_with_vim_mode(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude-opus"},
            "vim": {"mode": "normal"},
        }
        glyphs = self._glyphs()
        line, has_extra = _compose_line1(data, glyphs, git_info_empty)
        # vim mode shows first letter "n"
        assert "n" in line
        assert has_extra is True

    def test_git_status_counts_shown(self, git_info_active: dict) -> None:
        data = {
            "model": {"display_name": "claude"},
            "workspace": {"project_dir": "/home/user/myrepo"},
        }
        glyphs = self._glyphs()
        line, _ = _compose_line1(data, glyphs, git_info_active)
        # modified=3, staged=2, untracked=1 from fixture
        assert "~3" in line
        assert "+2" in line
        assert "?1" in line

    def test_non_default_output_style(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude"},
            "output_style": {"name": "compact"},
        }
        glyphs = self._glyphs()
        line, has_extra = _compose_line1(data, glyphs, git_info_empty)
        assert "compact" in line
        assert has_extra is True

    def test_default_output_style_not_shown(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude"},
            "output_style": {"name": "default"},
        }
        glyphs = self._glyphs()
        line, has_extra = _compose_line1(data, glyphs, git_info_empty)
        assert "default" not in line


# ---------------------------------------------------------------------------
# _compose_line2
# ---------------------------------------------------------------------------


class TestComposeLine2:
    def _glyphs(self) -> dict:
        return build_glyphs(False)

    def test_with_cost(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {"total_cost_usd": 1.23},
        }
        glyphs = self._glyphs()
        line = _compose_line2(data, glyphs)
        assert "1.23" in line

    def test_without_cost_shows_zero(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {},
        }
        glyphs = self._glyphs()
        line = _compose_line2(data, glyphs)
        assert "0.00" in line

    def test_duration_shown(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {"total_duration_ms": 90000},
        }
        glyphs = self._glyphs()
        line = _compose_line2(data, glyphs)
        assert "1m 30s" in line

    def test_lines_added_and_removed(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {"total_lines_added": 42, "total_lines_removed": 17},
        }
        glyphs = self._glyphs()
        line = _compose_line2(data, glyphs)
        assert "42" in line
        assert "17" in line

    def test_zero_lines_not_shown(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {"total_lines_added": 0, "total_lines_removed": 0},
        }
        glyphs = self._glyphs()
        line = _compose_line2(data, glyphs)
        # lines section only appears for > 0
        assert "+0" not in line
        assert "-0" not in line


# ---------------------------------------------------------------------------
# _compose_line3
# ---------------------------------------------------------------------------


class TestComposeLine3:
    def _glyphs(self) -> dict:
        return build_glyphs(False)

    def test_returns_none_when_all_none(self) -> None:
        usage = {"five_hour_pct": None, "seven_day_pct": None}
        assert _compose_line3(usage, self._glyphs()) is None

    def test_five_hour_only(self) -> None:
        usage = {
            "five_hour_pct": 45.0,
            "five_hour_resets_at": None,
            "seven_day_pct": None,
        }
        result = _compose_line3(usage, self._glyphs())
        assert result is not None
        assert "45%" in result

    def test_seven_day_only(self) -> None:
        usage = {
            "five_hour_pct": None,
            "seven_day_pct": 80.0,
            "seven_day_resets_at": None,
        }
        result = _compose_line3(usage, self._glyphs())
        assert result is not None
        assert "80%" in result

    def test_both_windows(self) -> None:
        usage = {
            "five_hour_pct": 45.0,
            "five_hour_resets_at": None,
            "seven_day_pct": 80.0,
            "seven_day_resets_at": None,
        }
        result = _compose_line3(usage, self._glyphs())
        assert result is not None
        assert "45%" in result
        assert "80%" in result

    def test_resets_string_included_when_present(self) -> None:
        from datetime import datetime, timezone

        ts = int(datetime(2026, 4, 11, 17, 0, 0, tzinfo=timezone.utc).timestamp())
        now_dt = datetime(2026, 4, 11, 12, 0, 0, tzinfo=timezone.utc)

        usage = {
            "five_hour_pct": 45.0,
            "five_hour_resets_at": ts,
            "seven_day_pct": None,
        }

        with patch("statusline.core.datetime") as mock_dt:
            local_result = datetime(
                2026, 4, 11, 17, 0, 0, tzinfo=timezone.utc
            ).astimezone()
            mock_dt.fromtimestamp.return_value = local_result
            mock_dt.fromisoformat.side_effect = datetime.fromisoformat
            mock_dt.now.return_value = now_dt.astimezone()
            result = _compose_line3(usage, self._glyphs())

        assert result is not None
        assert "resets" in result


# ---------------------------------------------------------------------------
# render (integration)
# ---------------------------------------------------------------------------


class TestRender:
    def test_single_line_mode(
        self, monkeypatch: pytest.MonkeyPatch, minimal_payload: dict
    ) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        git_info = {"is_git": "0"}
        result = render(minimal_payload, git_info)
        # No git, no agent, no worktree, no vim -> single line
        assert "\n" not in result
        assert "claude-3-5-sonnet" in result

    def test_two_line_mode_with_git(
        self,
        monkeypatch: pytest.MonkeyPatch,
        minimal_payload: dict,
        git_info_active: dict,
    ) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        minimal_payload["workspace"] = {"project_dir": "/home/user/myrepo"}
        result = render(minimal_payload, git_info_active)
        lines = result.split("\n")
        assert len(lines) == 2

    def test_three_line_mode_with_rate_limits(
        self,
        monkeypatch: pytest.MonkeyPatch,
        full_payload: dict,
        git_info_active: dict,
    ) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        result = render(full_payload, git_info_active)
        lines = result.split("\n")
        assert len(lines) == 3

    def test_nerd_font_uses_glyphs(
        self, monkeypatch: pytest.MonkeyPatch, minimal_payload: dict
    ) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "1")
        git_info = {"is_git": "0"}
        result = render(minimal_payload, git_info)
        # Nerd font rocket glyph u+f135
        assert "\uf135" in result

    def test_ascii_mode_no_nerd_glyphs(
        self, monkeypatch: pytest.MonkeyPatch, minimal_payload: dict
    ) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        git_info = {"is_git": "0"}
        result = render(minimal_payload, git_info)
        # No nerd font rocket glyph
        assert "\uf135" not in result

    def test_two_line_with_agent(
        self, monkeypatch: pytest.MonkeyPatch, minimal_payload: dict
    ) -> None:
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        minimal_payload["agent"] = {"name": "my-agent"}
        git_info = {"is_git": "0"}
        result = render(minimal_payload, git_info)
        lines = result.split("\n")
        assert len(lines) == 2
        assert "my-agent" in result

    def test_fallback_no_model(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """render still runs with empty model; won't crash."""
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        data = {"model": {}, "context_window": {}, "cost": {}}
        git_info = {"is_git": "0"}
        # Should not raise
        result = render(data, git_info)
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# _format_tokens
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("n", "expected"),
    [
        (0, "0"),
        (999, "999"),
        (1000, "1.0k"),
        (12345, "12.3k"),
        (1_000_000, "1.0M"),
        (2_500_000, "2.5M"),
    ],
)
def test_format_tokens(n: int, expected: str) -> None:
    assert _format_tokens(n) == expected


# ---------------------------------------------------------------------------
# Phase B5 new fields: session_name / session_id / version / tokens / api time
# ---------------------------------------------------------------------------


class TestNewFieldsLine1:
    def _glyphs(self) -> dict:
        return build_glyphs(False)

    def test_session_name_shown(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude"},
            "session_name": "my-session",
        }
        line, _ = _compose_line1(data, self._glyphs(), git_info_empty)
        assert "my-session" in line

    def test_session_id_truncated(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude"},
            "session_id": "abcdef1234567890",
        }
        line, _ = _compose_line1(data, self._glyphs(), git_info_empty)
        assert "abcdef12" in line
        # Full ID should not appear (only first 8 chars)
        assert "abcdef1234567890" not in line

    def test_session_name_takes_precedence_over_session_id(
        self, git_info_empty: dict
    ) -> None:
        data = {
            "model": {"display_name": "claude"},
            "session_name": "named",
            "session_id": "fallback-id",
        }
        line, _ = _compose_line1(data, self._glyphs(), git_info_empty)
        assert "named" in line
        assert "fallback" not in line

    def test_version_shown(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude"},
            "version": "2.1.94",
        }
        line, _ = _compose_line1(data, self._glyphs(), git_info_empty)
        assert "v2.1.94" in line

    def test_no_session_no_version_no_crash(self, git_info_empty: dict) -> None:
        data = {"model": {"display_name": "claude"}}
        line, _ = _compose_line1(data, self._glyphs(), git_info_empty)
        assert "claude" in line

    def test_transcript_path_creates_osc8_link(self, git_info_empty: dict) -> None:
        data = {
            "model": {"display_name": "claude"},
            "session_name": "my-sess",
            "transcript_path": "/tmp/session.jsonl",
        }
        line, _ = _compose_line1(data, self._glyphs(), git_info_empty)
        # OSC 8 sequence should be present
        assert "\033]8;;" in line
        assert "my-sess" in line


class TestNewFieldsLine2:
    def _glyphs(self) -> dict:
        return build_glyphs(False)

    def test_token_count_shown(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {},
            "total_input_tokens": 10000,
            "total_output_tokens": 2000,
        }
        line = _compose_line2(data, self._glyphs())
        # 10000 + 2000 = 12000 -> "12.0k tok"
        assert "12.0k" in line
        assert "tok" in line

    def test_token_count_only_input(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {},
            "total_input_tokens": 5000,
        }
        line = _compose_line2(data, self._glyphs())
        assert "5.0k" in line

    def test_token_count_absent_when_not_in_payload(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {},
        }
        line = _compose_line2(data, self._glyphs())
        assert "tok" not in line

    def test_api_duration_shown(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {},
            "total_api_duration_ms": 23456,
        }
        line = _compose_line2(data, self._glyphs())
        assert "api 23s" in line

    def test_api_duration_absent_when_not_in_payload(self) -> None:
        data = {
            "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
            "cost": {},
        }
        line = _compose_line2(data, self._glyphs())
        assert "api" not in line
