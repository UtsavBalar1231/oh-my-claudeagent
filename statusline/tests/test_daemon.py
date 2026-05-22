"""Protocol-level tests for the statusline daemon handler.

These tests exercise the wire protocol logic in StatuslineHandler without
actually starting a server. We simulate the handler by calling handle()
directly on a minimal object with mocked rfile/wfile.
"""

from __future__ import annotations

import io
import json
from unittest.mock import MagicMock, patch

from statusline.daemon import PROTOCOL_VERSION, StatuslineHandler


def _make_handler(request_line: str) -> tuple[StatuslineHandler, io.BytesIO]:
    """Construct a StatuslineHandler with mocked rfile/wfile."""
    handler = StatuslineHandler.__new__(StatuslineHandler)
    handler.rfile = io.BytesIO(request_line.encode("utf-8"))
    output = io.BytesIO()
    handler.wfile = output
    # Mock server with reset_idle_timer
    handler.server = MagicMock()
    return handler, output


def _decode_response(output: io.BytesIO) -> tuple[str, str]:
    """Return (status, body) from raw handler output bytes."""
    output.seek(0)
    raw = output.read().decode("utf-8")
    lines = raw.strip().split("\n", 1)
    header = lines[0] if lines else ""
    body = lines[1] if len(lines) > 1 else ""
    # header format: "<version>\t<status>"
    _, _, status = header.partition("\t")
    return status, body


class TestProtocol:
    def test_valid_request_returns_ok(self) -> None:
        payload = json.dumps(
            {
                "model": {"display_name": "claude-3-5-sonnet"},
                "context_window": {
                    "context_window_size": 200000,
                    "used_percentage": 10.0,
                },
                "cost": {},
                "workspace": {},
            }
        )
        line = f"{PROTOCOL_VERSION}\t{payload}\n"
        handler, output = _make_handler(line)

        with patch("statusline.daemon.get_git_info", return_value={"is_git": "0"}):
            handler.handle()

        status, body = _decode_response(output)
        assert status == "OK"
        assert len(body) > 0

    def test_wrong_version_returns_err(self) -> None:
        payload = json.dumps({"model": {"display_name": "claude"}})
        line = f"99\t{payload}\n"
        handler, output = _make_handler(line)
        handler.handle()
        status, _ = _decode_response(output)
        assert status == "ERR"

    def test_invalid_json_returns_err(self) -> None:
        line = f"{PROTOCOL_VERSION}\tnot-valid-json\n"
        handler, output = _make_handler(line)
        handler.handle()
        status, _ = _decode_response(output)
        assert status == "ERR"

    def test_empty_line_returns_nothing(self) -> None:
        handler, output = _make_handler("\n")
        handler.handle()
        output.seek(0)
        assert output.read() == b""

    def test_no_model_in_payload_returns_fallback(self) -> None:
        payload = json.dumps({"context_window": {}})
        line = f"{PROTOCOL_VERSION}\t{payload}\n"
        handler, output = _make_handler(line)
        handler.handle()
        status, body = _decode_response(output)
        assert status == "OK"
        assert "[claude]" in body

    def test_idle_timer_reset_on_valid_request(self) -> None:
        payload = json.dumps(
            {
                "model": {"display_name": "claude"},
                "context_window": {"context_window_size": 200000},
                "cost": {},
            }
        )
        line = f"{PROTOCOL_VERSION}\t{payload}\n"
        handler, _ = _make_handler(line)

        with patch("statusline.daemon.get_git_info", return_value={"is_git": "0"}):
            handler.handle()

        handler.server.reset_idle_timer.assert_called_once()


class TestIdleTimerGuards:
    """idle_timeout <= 0 must disable the shutdown timer entirely."""

    def _make_daemon_stub(self, idle_timeout: int):
        """Construct a StatuslineDaemon-like object without binding a socket."""
        from statusline.daemon import StatuslineDaemon

        d = StatuslineDaemon.__new__(StatuslineDaemon)
        # Minimal fields reset_idle_timer touches
        import threading

        d._idle_timeout = idle_timeout
        d._idle_timer = None
        d._lock = threading.Lock()
        return d

    def test_zero_idle_timeout_does_not_arm_timer(self) -> None:
        d = self._make_daemon_stub(0)
        d.reset_idle_timer()
        assert d._idle_timer is None

    def test_negative_idle_timeout_does_not_arm_timer(self) -> None:
        d = self._make_daemon_stub(-5)
        d.reset_idle_timer()
        assert d._idle_timer is None

    def test_positive_idle_timeout_arms_timer(self) -> None:
        d = self._make_daemon_stub(3600)
        d.reset_idle_timer()
        assert d._idle_timer is not None
        d._idle_timer.cancel()  # don't leak threads

    def test_reset_cancels_previous_timer(self) -> None:
        d = self._make_daemon_stub(3600)
        d.reset_idle_timer()
        first = d._idle_timer
        d.reset_idle_timer()
        second = d._idle_timer
        assert first is not second
        assert second is not None
        second.cancel()
