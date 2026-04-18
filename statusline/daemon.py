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
import select
import signal
import socket
import socketserver
import sys
import threading

from statusline.config import config
from statusline.core import FALLBACK, render
from statusline.git import get_git_info
from statusline.protocol import PROTOCOL_VERSION, _pid_path, _socket_path

# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------


class StatuslineHandler(socketserver.StreamRequestHandler):
    """Handle a single statusline request per connection."""

    server: StatuslineDaemon  # type: ignore[assignment]  # intentional narrowing

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
            output = render(data, git_info)
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
        idle_timeout: int | None = None,
    ) -> None:
        if idle_timeout is None:
            idle_timeout = config.idle_timeout
        super().__init__(addr, handler)
        self._idle_timeout = idle_timeout
        self._idle_timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self.reset_idle_timer()

    def reset_idle_timer(self) -> None:
        """Reset the idle shutdown timer."""
        with self._lock:
            if self._idle_timer is not None:
                self._idle_timer.cancel()
            self._idle_timer = threading.Timer(float(self._idle_timeout or 0), self._idle_shutdown)
            self._idle_timer.daemon = True
            self._idle_timer.start()

    def _idle_shutdown(self) -> None:
        """Shut down the server after idle timeout."""
        self.shutdown()

    def server_close(self) -> None:
        """Clean up timer and socket resources."""
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
# CLI commands
# ---------------------------------------------------------------------------


def _cmd_start(foreground: bool = False) -> None:
    """Start the daemon.

    In daemon mode uses a self-pipe readiness handshake so the caller blocks
    until the socket is bound (or times out after 2 s).  The grandchild writes
    b'1' to the write end of the pipe after a successful socket bind + PID
    write, or b'0' on failure.  The grandparent (original caller) waits on the
    read end with select() and exits 0/1 accordingly.
    """
    sock_path = _socket_path()

    # Handle stale socket on macOS
    if sys.platform != "linux":
        _remove_stale_socket(sock_path)

    if foreground:
        # Foreground mode: run server directly in this process.
        _run_server(sock_path, foreground=True, write_fd=None)
        return

    # --- Self-pipe readiness handshake ---
    read_fd, write_fd = os.pipe()

    pid = os.fork()
    if pid > 0:
        # ---- GRANDPARENT: wait for ready signal ----
        os.close(write_fd)
        ready, _, _ = select.select([read_fd], [], [], 2.0)
        if not ready:
            os.close(read_fd)
            sys.stderr.write("cc-statusline-daemon: daemon failed to come up within 2s\n")
            sys.stderr.flush()
            # Try to kill the child if we can still find it
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGTERM)
            os._exit(1)
        data = os.read(read_fd, 1)
        os.close(read_fd)
        os._exit(0 if data == b"1" else 1)

    # ---- CHILD (middle parent) ----
    os.close(read_fd)

    # Second fork: detach from session so the grandchild is not a session leader
    if os.fork() > 0:
        os._exit(0)  # middle parent exits immediately

    # ---- GRANDCHILD (actual daemon) ----
    os.setsid()

    # Redirect stdio to /dev/null
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    if devnull > 2:
        os.close(devnull)

    _run_server(sock_path, foreground=False, write_fd=write_fd)


def _run_server(sock_path: str, *, foreground: bool, write_fd: int | None) -> None:
    """Bind the socket, write PID, and enter serve_forever().

    write_fd: pipe write end used to signal readiness back to the grandparent.
              None in foreground mode (no pipe).
    """

    def _signal_ready(success: bool) -> None:
        """Write a ready byte to the grandparent and close the pipe end."""
        if write_fd is None:
            return
        with contextlib.suppress(OSError):
            os.write(write_fd, b"1" if success else b"0")
        with contextlib.suppress(OSError):
            os.close(write_fd)

    server: StatuslineDaemon | None = None

    def _handle_sigterm(signum: int, frame: object) -> None:
        if server is not None:
            threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    try:
        server = StatuslineDaemon(sock_path, StatuslineHandler)
        _write_pid()
        # Socket is bound and PID file written -- signal readiness BEFORE
        # blocking in serve_forever so the grandparent can exit cleanly.
        _signal_ready(True)
        server.serve_forever()
    except OSError as e:
        _signal_ready(False)
        if foreground:
            print(f"Failed to start daemon: {e}", file=sys.stderr)
            sys.exit(1)
        else:
            os._exit(1)
    finally:
        if server is not None:
            server.server_close()


def _cmd_stop() -> None:
    """Stop a running daemon by sending SIGTERM.

    Before signalling, probes the Unix socket to verify the PID is not stale.
    If the socket is unreachable the PID file is cleaned up and we return
    without sending SIGTERM (avoids killing an unrelated process that inherited
    the same PID after a daemon crash).
    """
    pid_path = _pid_path()
    sock_path = _socket_path()

    try:
        with open(pid_path) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        print("Daemon is not running (no PID file)")
        return

    # Probe the socket before signalling -- if unreachable the PID is stale.
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(0.5)
        probe.connect(sock_path)
        probe.close()
    except (ConnectionRefusedError, FileNotFoundError, OSError, TimeoutError):
        _cleanup()
        print("stopped (stale PID file cleaned)")
        return

    # Socket reachable -- real daemon is alive; send SIGTERM.
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Sent SIGTERM to daemon (PID {pid})")
    except ProcessLookupError:
        print(f"Daemon (PID {pid}) is not running")
        _cleanup()
    except PermissionError:
        print(f"Permission denied sending signal to PID {pid}")


def _cmd_status() -> None:
    """Check if daemon is running.

    Reads the PID file first (fast path: if absent, report stopped immediately).
    Then attempts a socket connect to confirm the process is actually listening.
    If the PID file exists but the socket is dead, removes the stale PID file
    and reports stopped.
    """
    pid_path = _pid_path()
    sock_path = _socket_path()

    # Check PID file
    try:
        with open(pid_path) as f:
            pid_str = f.read().strip()
        if not pid_str:
            raise ValueError("empty PID file")
    except (OSError, ValueError):
        print("stopped")
        return

    # PID file present -- verify socket is alive
    test_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        test_sock.settimeout(0.5)
        test_sock.connect(sock_path)
        test_sock.close()
        print("running")
    except (ConnectionRefusedError, FileNotFoundError, OSError):
        # Socket dead -- clean up stale PID file
        with contextlib.suppress(OSError):
            os.unlink(pid_path)
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
