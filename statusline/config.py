"""Configuration system for Claude Code statusline.

Reads environment variables with defaults. Module-level singleton ``config``
is the intended access point. All values are parsed once on first access
and cached for the lifetime of the process.
"""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Config class
# ---------------------------------------------------------------------------


class Config:
    """Lazy-loaded configuration from environment variables."""

    __slots__ = (
        "_idle_timeout",
        "_cache_ttl",
        "_git_timeout",
        "_bar_width",
        "_ratelimit_bar_width",
        "_threshold_warn",
        "_threshold_crit",
    )

    def __init__(self) -> None:
        self._idle_timeout: int | None = None
        self._cache_ttl: int | None = None
        self._git_timeout: int | None = None
        self._bar_width: int | None = None
        self._ratelimit_bar_width: int | None = None
        self._threshold_warn: int | None = None
        self._threshold_crit: int | None = None

    def _get_int(self, attr: str, env_var: str, default: int) -> int:
        val = getattr(self, attr)
        if val is not None:
            return val
        raw = os.environ.get(env_var)
        result = default
        if raw is not None:
            try:
                result = int(raw)
            except ValueError:
                pass
        object.__setattr__(self, attr, result)
        return result

    @property
    def idle_timeout(self) -> int:
        """Idle shutdown timeout in seconds (CLAUDE_STATUSLINE_IDLE_TIMEOUT)."""
        return self._get_int("_idle_timeout", "CLAUDE_STATUSLINE_IDLE_TIMEOUT", 1800)

    @property
    def cache_ttl(self) -> int:
        """Git cache TTL in seconds (CLAUDE_STATUSLINE_CACHE_TTL)."""
        return self._get_int("_cache_ttl", "CLAUDE_STATUSLINE_CACHE_TTL", 5)

    @property
    def git_timeout(self) -> int:
        """Git subprocess timeout in seconds (CLAUDE_STATUSLINE_GIT_TIMEOUT)."""
        return self._get_int("_git_timeout", "CLAUDE_STATUSLINE_GIT_TIMEOUT", 3)

    @property
    def bar_width(self) -> int:
        """Context bar width in blocks (CLAUDE_STATUSLINE_BAR_WIDTH)."""
        return self._get_int("_bar_width", "CLAUDE_STATUSLINE_BAR_WIDTH", 20)

    @property
    def ratelimit_bar_width(self) -> int:
        """Rate limit bar width in blocks (CLAUDE_STATUSLINE_RATELIMIT_BAR_WIDTH)."""
        return self._get_int(
            "_ratelimit_bar_width", "CLAUDE_STATUSLINE_RATELIMIT_BAR_WIDTH", 10
        )

    @property
    def threshold_warn(self) -> int:
        """Warning threshold percentage (CLAUDE_STATUSLINE_THRESHOLD_WARN)."""
        return self._get_int("_threshold_warn", "CLAUDE_STATUSLINE_THRESHOLD_WARN", 60)

    @property
    def threshold_crit(self) -> int:
        """Critical threshold percentage (CLAUDE_STATUSLINE_THRESHOLD_CRIT)."""
        return self._get_int("_threshold_crit", "CLAUDE_STATUSLINE_THRESHOLD_CRIT", 85)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

config = Config()
