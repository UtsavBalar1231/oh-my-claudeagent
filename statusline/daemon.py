"""Unix domain socket daemon for Claude Code statusline.

Keeps the Python interpreter warm, eliminating the ~19ms startup + import cost.
Serves statusline renders over a simple line-based protocol.

Wire protocol:
  Request:  <version>\\t<json_payload>\\n
  Response: <version>\\t<status>\\n<rendered_output>\\n
  Daemon closes connection after sending response.

CLI:
  python3 daemon.py [start]        Start daemon (daemonizes by default)
  python3 daemon.py stop           Send SIGTERM to running daemon
  python3 daemon.py status         Print "running" or "stopped"
  python3 daemon.py --foreground   Run in foreground (for debugging)
"""

from __future__ import annotations

import contextlib
import json
import os
import signal
import socket
import socketserver
import sys
import threading

from statusline.core import FALLBACK, render
from statusline.git import get_git_info
from statusline.usage import get_usage

# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------

PROTOCOL_VERSION = "1"

# ---------------------------------------------------------------------------
# Socket path
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
    return f"/tmp/cc-statusline-{os.getuid()}.pid"


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------


class StatuslineHandler(socketserver.StreamRequestHandler):
    """Handle a single statusline request per connection."""

    server: StatuslineDaemon

    def handle(self) -> None:
        raw = self.rfile.readline()
        if not raw:
            return

        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            return

        version, _, payload = line.partition("\t")

        if version != PROTOCOL_VERSION:
            self.wfile.write(f"{PROTOCOL_VERSION}\tERR\n{FALLBACK}\n".encode())
            return

        try:
            data = json.loads(payload)
            if not isinstance(data, dict) or not data.get("model"):
                self.wfile.write(f"{PROTOCOL_VERSION}\tOK\n{FALLBACK}\n".encode())
                return

            workspace = data.get("workspace", {})
            project_dir = workspace.get("project_dir", data.get("cwd", ""))
            git_info = get_git_info(project_dir) if project_dir else {}
            usage = self.server.get_cached_usage()
            output = render(data, git_info, usage)
            self.wfile.write(f"{PROTOCOL_VERSION}\tOK\n{output}\n".encode())
        except Exception:
            self.wfile.write(f"{PROTOCOL_VERSION}\tERR\n{FALLBACK}\n".encode())

        # Reset idle timer on each request
        self.server.reset_idle_timer()


# ---------------------------------------------------------------------------
# Server with idle timeout
# ---------------------------------------------------------------------------


class StatuslineDaemon(socketserver.ThreadingUnixStreamServer):
    """Threaded Unix stream server with idle auto-shutdown."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        addr: str,
        handler: type[socketserver.BaseRequestHandler],
        idle_timeout: int = 1800,
    ) -> None:
        super().__init__(addr, handler)
        self._idle_timeout = idle_timeout
        self._idle_timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self.reset_idle_timer()
        # Usage data: background thread refreshes, handler reads
        self._usage_data: dict | None = None
        self._usage_lock = threading.Lock()
        self._usage_thread: threading.Timer | None = None
        self._refresh_usage()

    def reset_idle_timer(self) -> None:
        """Reset the idle shutdown timer."""
        with self._lock:
            if self._idle_timer is not None:
                self._idle_timer.cancel()
            self._idle_timer = threading.Timer(self._idle_timeout, self._idle_shutdown)
            self._idle_timer.daemon = True
            self._idle_timer.start()

    def _idle_shutdown(self) -> None:
        """Shut down the server after idle timeout."""
        self.shutdown()

    def _refresh_usage(self) -> None:
        """Fetch usage data and schedule next refresh."""
        try:
            data = get_usage()
            with self._usage_lock:
                self._usage_data = data
        except Exception:
            pass
        self._usage_thread = threading.Timer(300.0, self._refresh_usage)
        self._usage_thread.daemon = True
        self._usage_thread.start()

    def get_cached_usage(self) -> dict | None:
        """Thread-safe read of cached usage data."""
        with self._usage_lock:
            return self._usage_data

    def server_close(self) -> None:
        """Clean up timer and socket resources."""
        if self._usage_thread is not None:
            self._usage_thread.cancel()
            self._usage_thread = None
        with self._lock:
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
        super().server_close()
        # Clean up filesystem socket (macOS) and PID file
        _cleanup()


# ---------------------------------------------------------------------------
# Cleanup helpers
# ---------------------------------------------------------------------------


def _cleanup() -> None:
    """Remove PID file and filesystem socket if present."""
    pid_path = _pid_path()
    with contextlib.suppress(OSError):
        os.unlink(pid_path)

    if sys.platform != "linux":
        sock_path = _socket_path()
        with contextlib.suppress(OSError):
            os.unlink(sock_path)


def _write_pid() -> None:
    """Write current PID to pidfile."""
    pid_path = _pid_path()
    try:
        with open(pid_path, "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Stale socket detection (macOS)
# ---------------------------------------------------------------------------


def _remove_stale_socket(sock_path: str) -> None:
    """On macOS, check if a filesystem socket is stale and remove it."""
    if sys.platform == "linux":
        return  # abstract namespace, no stale sockets
    if not os.path.exists(sock_path):
        return
    # Try connecting -- if refused, the socket is stale
    test_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        test_sock.settimeout(0.5)
        test_sock.connect(sock_path)
        # Connected -- daemon is running, don't remove
        test_sock.close()
    except (ConnectionRefusedError, OSError):
        # Stale socket -- remove it
        with contextlib.suppress(OSError):
            os.unlink(sock_path)


# ---------------------------------------------------------------------------
# Daemonize
# ---------------------------------------------------------------------------


def _daemonize() -> None:
    """Fork into background, detach from terminal."""
    pid = os.fork()
    if pid > 0:
        # Parent exits
        os._exit(0)

    # Child becomes session leader
    os.setsid()

    # Second fork to prevent zombie processes
    pid = os.fork()
    if pid > 0:
        os._exit(0)

    # Redirect stdio to /dev/null
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    if devnull > 2:
        os.close(devnull)


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------


def _cmd_start(foreground: bool = False) -> None:
    """Start the daemon."""
    sock_path = _socket_path()

    # Handle stale socket on macOS
    if sys.platform != "linux":
        _remove_stale_socket(sock_path)

    if not foreground:
        _daemonize()

    # Set up signal handler for graceful shutdown
    server: StatuslineDaemon | None = None

    def _handle_sigterm(signum: int, frame: object) -> None:
        if server is not None:
            # Run shutdown in a thread to avoid deadlock
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    try:
        server = StatuslineDaemon(sock_path, StatuslineHandler)
        _write_pid()
        server.serve_forever()
    except OSError as e:
        if not foreground:
            # Daemon mode -- can't print, just exit
            sys.exit(1)
        print(f"Failed to start daemon: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if server is not None:
            server.server_close()


def _cmd_stop() -> None:
    """Stop a running daemon by sending SIGTERM."""
    pid_path = _pid_path()
    try:
        with open(pid_path) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        print("Daemon is not running (no PID file)")
        return

    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Sent SIGTERM to daemon (PID {pid})")
    except ProcessLookupError:
        print(f"Daemon (PID {pid}) is not running")
        _cleanup()
    except PermissionError:
        print(f"Permission denied sending signal to PID {pid}")


def _cmd_status() -> None:
    """Check if daemon is running by attempting socket connect."""
    sock_path = _socket_path()
    test_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        test_sock.settimeout(0.5)
        test_sock.connect(sock_path)
        test_sock.close()
        print("running")
    except (ConnectionRefusedError, FileNotFoundError, OSError):
        print("stopped")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """CLI entry point for cc-statusline-daemon."""
    args = sys.argv[1:]

    if not args or args[0] == "start":
        foreground = "--foreground" in args
        _cmd_start(foreground=foreground)
    elif args[0] == "stop" or args[0] == "--kill":
        _cmd_stop()
    elif args[0] == "status":
        _cmd_status()
    elif args[0] == "--foreground":
        _cmd_start(foreground=True)
    else:
        print(f"Unknown command: {args[0]}", file=sys.stderr)
        print("Usage: cc-statusline-daemon [start|stop|status|--foreground]")
        sys.exit(1)


if __name__ == "__main__":
    main()
