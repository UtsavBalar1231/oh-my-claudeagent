"""Shared protocol constants and path helpers for the statusline daemon/client.
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile

# ---------------------------------------------------------------------------
# Protocol version
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "1"

# ---------------------------------------------------------------------------
# Session ID derivation
# ---------------------------------------------------------------------------

_CACHED_SESSION_ID: str | None = None


def _session_id() -> str:
    """Return a stable per-session identifier.

    Prefers CLAUDE_SESSION_ID env var (hashed for path safety).  Falls back to
    a hash of PPID + the current hour so the value is stable across multiple
    calls within the same parent-process lifetime (~hour window).  The result
    is cached module-level after first computation.
    """
    global _CACHED_SESSION_ID
    if _CACHED_SESSION_ID is not None:
        return _CACHED_SESSION_ID
    sid = os.environ.get("CLAUDE_SESSION_ID")
    if sid:
        # Hash to avoid path-unsafe characters in the env var value
        _CACHED_SESSION_ID = hashlib.sha256(sid.encode()).hexdigest()[:12]
    else:
        # Stable fallback: PPID + hour-granularity timestamp
        hour_bucket = (int(__import__("time").time()) // 3600) * 3600
        seed = f"{os.getppid()}-{hour_bucket}"
        _CACHED_SESSION_ID = hashlib.sha256(seed.encode()).hexdigest()[:12]
    return _CACHED_SESSION_ID


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def _socket_path() -> str:
    """Return the platform-appropriate Unix socket path for this session."""
    uid = os.getuid()
    sid = _session_id()
    if sys.platform == "linux":
        # Abstract namespace socket -- auto-cleanup on process exit
        return f"\0cc-statusline-{uid}-{sid}"
    # macOS / other: filesystem socket under XDG_RUNTIME_DIR or tmpdir
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR", tempfile.gettempdir())
    return os.path.join(runtime_dir, f"cc-statusline-{uid}-{sid}.sock")


def _pid_path() -> str:
    """Return the path to the daemon PID file for this session."""
    uid = os.getuid()
    sid = _session_id()
    return os.path.join(tempfile.gettempdir(), f"cc-statusline-{uid}-{sid}.pid")
