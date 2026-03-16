"""Smart client for Claude Code statusline.

Reads JSON from stdin, sends to the daemon over Unix socket, prints response.
Falls back to direct rendering if the daemon is unavailable.
Auto-starts the daemon on first connection failure.

Environment:
  CLAUDE_STATUSLINE_MODE=daemon  (default) try daemon, fall back to direct
  CLAUDE_STATUSLINE_MODE=direct  skip daemon, always render inline
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import socket
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Protocol (shared with daemon)
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "1"

# ---------------------------------------------------------------------------
# Socket path (must match daemon.py)
# ---------------------------------------------------------------------------


def _socket_path() -> str:
    """Return the platform-appropriate Unix socket path."""
    uid = os.getuid()
    if sys.platform == "linux":
        return f"\0cc-statusline-{uid}"
    return f"/tmp/cc-statusline-{uid}.sock"


# ---------------------------------------------------------------------------
# Daemon communication
# ---------------------------------------------------------------------------


def _try_daemon(payload: str) -> str | None:
    """Try to get statusline from daemon. Returns rendered output or None."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(1.0)
    try:
        sock.connect(_socket_path())
        sock.sendall(f"{PROTOCOL_VERSION}\t{payload}\n".encode())
        response = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            response += chunk
        lines = response.decode("utf-8", errors="replace").strip().split("\n")
        if len(lines) >= 2 and lines[0].startswith(f"{PROTOCOL_VERSION}\tOK"):
            return "\n".join(lines[1:])
        return None
    except (ConnectionRefusedError, FileNotFoundError, OSError, TimeoutError):
        return None
    finally:
        sock.close()


# ---------------------------------------------------------------------------
# Daemon auto-start
# ---------------------------------------------------------------------------


def _is_daemon_running() -> bool:
    """Check if daemon is reachable via socket connect."""
    test_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        test_sock.settimeout(0.5)
        test_sock.connect(_socket_path())
        test_sock.close()
        return True
    except (ConnectionRefusedError, FileNotFoundError, OSError):
        return False


def _start_daemon() -> bool:
    """Start daemon if not running. Returns True if daemon is available."""
    lockfile = f"/tmp/cc-statusline-{os.getuid()}.lock"
    fd = -1
    try:
        fd = os.open(lockfile, os.O_CREAT | os.O_WRONLY)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

        # Double-check inside lock -- another client may have started it
        if _is_daemon_running():
            return True

        # Start daemon as a subprocess
        daemon_module = os.path.join(os.path.dirname(__file__), "daemon.py")
        subprocess.Popen(
            [sys.executable, daemon_module],
            close_fds=True,
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Wait for socket to become available (up to 200ms, poll every 20ms)
        for _ in range(10):
            time.sleep(0.02)
            if _is_daemon_running():
                return True

        return False
    except (BlockingIOError, OSError):
        # Another process holds the lock -- they're starting the daemon
        # Wait briefly and check if it came up
        for _ in range(5):
            time.sleep(0.02)
            if _is_daemon_running():
                return True
        return False
    finally:
        if fd >= 0:
            with contextlib.suppress(OSError):
                os.close(fd)


# ---------------------------------------------------------------------------
# Direct mode fallback
# ---------------------------------------------------------------------------


def _render_direct(payload: str) -> str:
    """Render statusline inline (fallback when daemon is unavailable)."""
    from statusline.core import FALLBACK, render
    from statusline.git import get_git_info

    data = json.loads(payload)
    if not isinstance(data, dict) or not data.get("model"):
        return FALLBACK

    workspace = data.get("workspace", {})
    project_dir = workspace.get("project_dir", data.get("cwd", ""))
    git_info = get_git_info(project_dir) if project_dir else {}
    return render(data, git_info)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """CLI entry point for cc-statusline."""
    try:
        payload = sys.stdin.read().strip()
        if not payload:
            print("[claude]")
            return

        mode = os.environ.get("CLAUDE_STATUSLINE_MODE", "daemon")

        if mode == "direct":
            print(_render_direct(payload))
            return

        # Try daemon first
        result = _try_daemon(payload)
        if result is not None:
            print(result)
            return

        # Daemon not running -- try to start it
        if _start_daemon():
            result = _try_daemon(payload)
            if result is not None:
                print(result)
                return

        # Final fallback: render directly
        print(_render_direct(payload))
    except Exception:
        print("[claude]")


if __name__ == "__main__":
    main()
