"""Tests for repo/PR segment (v2.1.145), terminal columns (v2.1.153), and remaining_percentage.

repo/PR segment  v2.1.145 — workspace.repo.{host,owner,name} + pr.{number,url,review_state}
terminal columns v2.1.153 — COLUMNS/LINES env vars for terminal width
remaining_pct    docs     — context_window.remaining_percentage preferred over computed value
"""

from __future__ import annotations

import re

import pytest

from statusline.core import (
    DIM,
    GREEN,
    RED,
    YELLOW,
    RST,
    _compose_line1,
    _compose_repo_pr,
    _render_context_bar,
    build_glyphs,
    terminal_columns,
    render,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _strip_ansi(s: str) -> str:
    """Remove ANSI escape sequences and OSC sequences from a string."""
    s = re.sub(r"\x1b\[[0-9;]*m", "", s)
    s = re.sub(r"\x1b\]8;;[^\a]*\a[^\x1b]*\x1b\]8;;\a", lambda m: m.group(0).split("\a")[1], s)
    return s


def _ascii_glyphs() -> dict:
    return build_glyphs(False)


def _nerd_glyphs() -> dict:
    return build_glyphs(True)


# ---------------------------------------------------------------------------
# remaining_percentage preference
# ---------------------------------------------------------------------------


class TestRemainingPercentage:
    """prefer context_window.remaining_percentage over computed fallback (v2.1.docs)."""

    def test_remaining_percentage_used_when_present_and_pct_none(self) -> None:
        """remaining_percentage=92.0 → used = 8.0% (100 - 92)."""
        ctx = {
            "context_window_size": 200000,
            "remaining_percentage": 92.0,
        }
        bar = _render_context_bar(None, ctx, False, bar_width=10)
        assert "8%" in bar

    def test_explicit_pct_takes_precedence_over_remaining_percentage(self) -> None:
        """When used_percentage (pct arg) is present, it wins over remaining_percentage."""
        ctx = {
            "context_window_size": 200000,
            "remaining_percentage": 70.0,  # would imply 30%
        }
        # Pass explicit pct=50 — should see 50%, not 30%
        bar = _render_context_bar(50.0, ctx, False, bar_width=10)
        assert "50%" in bar
        assert "30%" not in bar

    def test_remaining_percentage_absent_falls_back_to_current_usage(self) -> None:
        """When remaining_percentage is absent, fall back to current_usage calculation."""
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

    def test_remaining_percentage_absent_and_no_current_usage_shows_waiting(self) -> None:
        """No remaining_percentage, no current_usage → waiting placeholder."""
        ctx = {"context_window_size": 200000}
        bar = _render_context_bar(None, ctx, False, bar_width=10)
        assert "waiting" in bar

    def test_remaining_percentage_zero_means_full_context(self) -> None:
        """remaining_percentage=0.0 → 100% used."""
        ctx = {"context_window_size": 200000, "remaining_percentage": 0.0}
        bar = _render_context_bar(None, ctx, False, bar_width=10)
        assert "100%" in bar

    def test_remaining_percentage_present_in_full_payload_render(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Integration: render() uses remaining_percentage when no used_percentage."""
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
        data = {
            "model": {"display_name": "claude"},
            "context_window": {
                "context_window_size": 200000,
                "remaining_percentage": 75.0,  # implies 25% used
            },
            "cost": {},
        }
        result = render(data, {"is_git": "0"})
        assert "25%" in result


# ---------------------------------------------------------------------------
# repo/PR segment — _compose_repo_pr
# ---------------------------------------------------------------------------


class TestComposePrSegment:
    """Unit tests for the _compose_repo_pr helper (repo/PR segment, v2.1.145)."""

    def test_no_workspace_returns_empty(self) -> None:
        assert _compose_repo_pr({}, _ascii_glyphs(), False) == ""

    def test_no_repo_in_workspace_returns_empty(self) -> None:
        data: dict = {"workspace": {}}
        assert _compose_repo_pr(data, _ascii_glyphs(), False) == ""

    def test_empty_repo_name_returns_empty(self) -> None:
        data: dict = {"workspace": {"repo": {"name": ""}}}
        assert _compose_repo_pr(data, _ascii_glyphs(), False) == ""

    def test_repo_name_only(self) -> None:
        data: dict = {"workspace": {"repo": {"name": "myrepo"}}}
        result = _strip_ansi(_compose_repo_pr(data, _ascii_glyphs(), False))
        assert "myrepo" in result

    def test_owner_and_name_combined(self) -> None:
        data: dict = {
            "workspace": {"repo": {"name": "myrepo", "owner": "myorg"}}
        }
        result = _strip_ansi(_compose_repo_pr(data, _ascii_glyphs(), False))
        assert "myorg/myrepo" in result

    def test_pr_number_shown(self) -> None:
        data: dict = {
            "workspace": {"repo": {"name": "myrepo", "owner": "myorg"}},
            "pr": {"number": 42},
        }
        result = _strip_ansi(_compose_repo_pr(data, _ascii_glyphs(), False))
        assert "#42" in result

    def test_pr_url_creates_osc8_link(self) -> None:
        data: dict = {
            "workspace": {"repo": {"name": "myrepo", "owner": "myorg"}},
            "pr": {"number": 7, "url": "https://github.com/myorg/myrepo/pull/7"},
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        # OSC 8 sequence for the PR URL
        assert "\033]8;;" in result
        assert "github.com/myorg/myrepo/pull/7" in result

    def test_pr_without_review_state(self) -> None:
        """PR present but review_state absent — must not crash; no state glyph."""
        data: dict = {
            "workspace": {"repo": {"name": "myrepo"}},
            "pr": {"number": 1},
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        assert result != ""
        # No state glyphs should appear in plain text
        plain = _strip_ansi(result)
        assert "#1" in plain

    def test_review_state_approved(self) -> None:
        data: dict = {
            "workspace": {"repo": {"name": "myrepo"}},
            "pr": {"number": 5, "review_state": "approved"},
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        assert "+" in result  # ASCII approved glyph

    def test_review_state_changes_requested(self) -> None:
        data: dict = {
            "workspace": {"repo": {"name": "myrepo"}},
            "pr": {"number": 5, "review_state": "changes_requested"},
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        # In ANSI output, "!" is the ASCII glyph for changes_requested
        # Check that the RED color is in the output
        assert RED in result

    def test_review_state_pending(self) -> None:
        data: dict = {
            "workspace": {"repo": {"name": "myrepo"}},
            "pr": {"number": 5, "review_state": "pending"},
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        assert YELLOW in result

    def test_review_state_draft(self) -> None:
        data: dict = {
            "workspace": {"repo": {"name": "myrepo"}},
            "pr": {"number": 5, "review_state": "draft"},
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        assert DIM in result

    def test_unknown_review_state_no_crash(self) -> None:
        """An unrecognized review_state must not crash the renderer."""
        data: dict = {
            "workspace": {"repo": {"name": "myrepo"}},
            "pr": {"number": 5, "review_state": "unknown_future_state"},
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        assert "#5" in _strip_ansi(result)

    def test_repo_with_host_creates_link(self) -> None:
        data: dict = {
            "workspace": {
                "repo": {
                    "host": "github.com",
                    "owner": "myorg",
                    "name": "myrepo",
                }
            }
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        # OSC 8 link to the repo
        assert "github.com/myorg/myrepo" in result

    def test_repo_without_host_no_link(self) -> None:
        """No host → no OSC 8 link, just plain text label."""
        data: dict = {
            "workspace": {"repo": {"owner": "myorg", "name": "myrepo"}}
        }
        result = _compose_repo_pr(data, _ascii_glyphs(), False)
        # No OSC 8 sequences
        assert "\033]8;;" not in result


# ---------------------------------------------------------------------------
# repo/PR segment — integration with _compose_line1
# ---------------------------------------------------------------------------


class TestComposeLine1RepoSegment:
    """Integration: _compose_line1 emits repo/PR segment when fields present."""

    def test_line1_shows_repo_when_present(self) -> None:
        data: dict = {
            "model": {"display_name": "claude"},
            "workspace": {
                "project_dir": "/home/user/myrepo",
                "repo": {"owner": "myorg", "name": "myrepo"},
            },
        }
        line, has_extra = _compose_line1(data, _ascii_glyphs(), {"is_git": "0"})
        assert "myorg/myrepo" in _strip_ansi(line)
        assert has_extra is True

    def test_line1_no_segment_when_repo_absent(self) -> None:
        """No workspace.repo → no repo/PR segment, no crash."""
        data: dict = {
            "model": {"display_name": "claude"},
            "workspace": {"project_dir": "/home/user/myrepo"},
        }
        line, _ = _compose_line1(data, _ascii_glyphs(), {"is_git": "0"})
        # No slash-separated owner/name
        assert "/" not in _strip_ansi(line).replace("claude", "")

    def test_line1_with_pr_number_and_review_state(self) -> None:
        data: dict = {
            "model": {"display_name": "claude"},
            "workspace": {"repo": {"owner": "acme", "name": "api"}},
            "pr": {"number": 99, "review_state": "approved"},
        }
        line, has_extra = _compose_line1(data, _ascii_glyphs(), {"is_git": "0"})
        plain = _strip_ansi(line)
        assert "acme/api" in plain
        assert "#99" in plain
        assert has_extra is True

    def test_line1_pr_without_review_state_no_crash(self) -> None:
        """pr without review_state must not crash _compose_line1."""
        data: dict = {
            "model": {"display_name": "claude"},
            "workspace": {"repo": {"name": "api"}},
            "pr": {"number": 3},
        }
        line, _ = _compose_line1(data, _ascii_glyphs(), {"is_git": "0"})
        assert "#3" in _strip_ansi(line)


# ---------------------------------------------------------------------------
# terminal_columns()
# ---------------------------------------------------------------------------


class TestTerminalColumns:
    """terminal_columns() prefers payload field, then COLUMNS env, then 80 (v2.1.153)."""

    def test_payload_columns_takes_precedence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("COLUMNS", "120")
        assert terminal_columns(payload_columns=200) == 200

    def test_env_columns_used_when_no_payload(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("COLUMNS", "132")
        monkeypatch.delenv("LINES", raising=False)
        assert terminal_columns() == 132

    def test_default_used_when_no_payload_no_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("COLUMNS", raising=False)
        assert terminal_columns() == 80

    def test_custom_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("COLUMNS", raising=False)
        assert terminal_columns(default=100) == 100

    def test_env_columns_non_digit_ignored(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("COLUMNS", "auto")
        assert terminal_columns() == 80

    def test_payload_zero_not_used(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """payload_columns=0 is falsy/invalid — skip to env."""
        monkeypatch.setenv("COLUMNS", "120")
        assert terminal_columns(payload_columns=0) == 120

    def test_env_columns_zero_not_used(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """COLUMNS=0 is invalid — skip to default."""
        monkeypatch.setenv("COLUMNS", "0")
        assert terminal_columns() == 80


class TestBinSubagentStatuslineColumns:
    """Verify bin/omca-subagent-statusline COLUMNS fallback behavior (v2.1.153)."""

    def test_columns_from_payload(self, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
        """payload.columns takes precedence over COLUMNS env."""
        import json
        import subprocess
        import sys

        monkeypatch.delenv("COLUMNS", raising=False)
        payload = {
            "columns": 40,
            "tasks": [{"id": "t1", "name": "a" * 50}],
        }
        bin_path = str(
            __import__("pathlib").Path(__file__).parent.parent.parent / "bin" / "omca-subagent-statusline"
        )
        result = subprocess.run(
            [sys.executable, bin_path],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        out = json.loads(result.stdout.strip())
        # content length should be capped at 40 chars (cols - 1 + ellipsis)
        assert len(out["content"]) <= 40

    def test_columns_from_env_when_payload_missing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """COLUMNS env used when payload has no columns field."""
        import json
        import subprocess
        import sys

        monkeypatch.setenv("COLUMNS", "30")
        long_name = "x" * 60
        payload = {"tasks": [{"id": "t1", "name": long_name}]}
        bin_path = str(
            __import__("pathlib").Path(__file__).parent.parent.parent / "bin" / "omca-subagent-statusline"
        )
        result = subprocess.run(
            [sys.executable, bin_path],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env={**__import__("os").environ, "COLUMNS": "30"},
        )
        assert result.returncode == 0
        out = json.loads(result.stdout.strip())
        assert len(out["content"]) <= 30
