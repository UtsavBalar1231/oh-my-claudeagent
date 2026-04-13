"""Shared pytest fixtures for statusline tests."""

from __future__ import annotations

import pytest


@pytest.fixture()
def minimal_payload() -> dict:
    """Minimal valid payload with only required model field."""
    return {
        "model": {"display_name": "claude-3-5-sonnet"},
        "context_window": {"context_window_size": 200000, "used_percentage": 10.0},
        "cost": {},
    }


@pytest.fixture()
def full_payload() -> dict:
    """Full payload with all optional fields populated."""
    return {
        "model": {"display_name": "claude-opus-4-5"},
        "workspace": {
            "project_dir": "/home/user/projects/myrepo",
            "added_dirs": ["/home/user/extra1", "/home/user/extra2"],
        },
        "context_window": {
            "context_window_size": 200000,
            "used_percentage": 72.5,
            "current_usage": {
                "input_tokens": 100000,
                "cache_creation_input_tokens": 20000,
                "cache_read_input_tokens": 5000,
                "output_tokens": 2000,
            },
        },
        "cost": {
            "total_cost_usd": 1.23,
            "total_duration_ms": 125000,
            "total_lines_added": 42,
            "total_lines_removed": 17,
        },
        "rate_limits": {
            "five_hour": {"used_percentage": 45.0, "resets_at": 1700000000},
            "seven_day": {"used_percentage": 80.0, "resets_at": 1700086400},
        },
        "exceeds_200k_tokens": False,
    }


@pytest.fixture()
def git_info_active() -> dict:
    """Git info for an active repo with changes."""
    return {
        "is_git": "1",
        "git_dir": "/home/user/projects/myrepo/.git",
        "branch": "main",
        "staged": "2",
        "modified": "3",
        "untracked": "1",
        "remote": "git@github.com:user/myrepo.git",
    }


@pytest.fixture()
def git_info_empty() -> dict:
    """Git info indicating not a git repo."""
    return {"is_git": "0"}


@pytest.fixture()
def mock_nerd_font(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force nerd font detection to True."""
    monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "1")


@pytest.fixture()
def mock_ascii(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force nerd font detection to False (ASCII mode)."""
    monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")
