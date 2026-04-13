"""Shared protocol constants and path helpers for the statusline daemon/client.
"""

from __future__ import annotations

import os
import sys

# ---------------------------------------------------------------------------
# Protocol version
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "1"

# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def _socket_path() -> str:
    """Return the platform-appropriate Unix socket path."""
    uid = os.getuid()
    if sys.platform == "linux":
        # Abstract namespace socket -- auto-cleanup on process exit
        return f"\0cc-statusline-{uid}"
    # macOS / other: filesystem socket
    return f"/tmp/cc-statusline-{uid}.sock"


def _pid_path() -> str:
    """Return the path to the daemon PID file."""
    return f"/tmp/cc-statusline-{os.getuid()}.pid"
