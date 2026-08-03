"""Integration tests for statusline.client (live daemon and fallback)."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from statusline.client import _render_direct, _try_daemon
from statusline.core import FALLBACK, render
from statusline.daemon import StatuslineDaemon, StatuslineHandler
from statusline.types import StatuslinePayload

# ---------------------------------------------------------------------------
# _try_daemon -- driven against a real daemon over a real Unix socket
# ---------------------------------------------------------------------------


@pytest.fixture()
def live_daemon(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[StatuslineDaemon]:
    """Serve a real StatuslineDaemon on a tmp_path socket for the test's lifetime."""
    sock_path = str(tmp_path / "daemon.sock")
    server = StatuslineDaemon(sock_path, StatuslineHandler, idle_timeout=0)
    monkeypatch.setattr("statusline.client._socket_path", lambda: sock_path)
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
    )
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()
        assert not thread.is_alive(), "daemon thread failed to shut down"


class TestTryDaemon:
    def test_ok_response_body_round_trips(
        self, live_daemon: StatuslineDaemon, mock_ascii: None
    ) -> None:
        data: StatuslinePayload = {
            "model": {"display_name": "claude-3-5-sonnet"},
            "context_window": {
                "context_window_size": 200000,
                "used_percentage": 10.0,
            },
            "cost": {},
        }
        result = _try_daemon(json.dumps(data))
        assert result == render(data, {})

    def test_multiline_body_survives_the_framing_loop(
        self, live_daemon: StatuslineDaemon
    ) -> None:
        """A body spanning several lines is rejoined intact, header stripped."""
        body = "first\nsecond\nthird"
        payload = json.dumps({"model": {"display_name": "claude"}, "cost": {}})
        with patch("statusline.daemon.render", return_value=body):
            result = _try_daemon(payload)
        assert result == body

    def test_err_response_returns_none(self, live_daemon: StatuslineDaemon) -> None:
        assert _try_daemon("not-valid-json") is None

    def test_version_mismatch_returns_none(
        self, live_daemon: StatuslineDaemon, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr("statusline.client.PROTOCOL_VERSION", "99")
        payload = json.dumps({"model": {"display_name": "claude"}, "cost": {}})
        assert _try_daemon(payload) is None

    def test_no_model_payload_yields_fallback_body(
        self, live_daemon: StatuslineDaemon
    ) -> None:
        assert _try_daemon(json.dumps({"context_window": {}})) == FALLBACK

    def test_returns_none_on_connection_refused(self) -> None:
        payload = json.dumps({"model": {"display_name": "claude"}})

        mock_sock = MagicMock()
        mock_sock.connect.side_effect = ConnectionRefusedError("refused")
        mock_sock.close = MagicMock()

        with patch("statusline.client.socket.socket", return_value=mock_sock):
            result = _try_daemon(payload)

        assert result is None


# ---------------------------------------------------------------------------
# _render_direct
# ---------------------------------------------------------------------------


class TestRenderDirect:
    def test_valid_payload_renders(self) -> None:
        payload = json.dumps(
            {
                "model": {"display_name": "claude-3-5-sonnet"},
                "context_window": {
                    "context_window_size": 200000,
                    "used_percentage": 10.0,
                },
                "cost": {},
            }
        )
        with patch("statusline.git.get_git_info", return_value={"is_git": "0"}):
            result = _render_direct(payload)
        assert isinstance(result, str)
        assert "claude-3-5-sonnet" in result

    def test_missing_model_returns_fallback(self) -> None:
        payload = json.dumps({"context_window": {}})
        result = _render_direct(payload)
        assert result == "[claude]"

    def test_empty_model_returns_fallback(self) -> None:
        payload = json.dumps({"model": None})
        result = _render_direct(payload)
        assert result == "[claude]"

    def test_render_with_git_info(self) -> None:
        payload = json.dumps(
            {
                "model": {"display_name": "claude-opus"},
                "workspace": {"project_dir": "/home/user/repo"},
                "context_window": {
                    "context_window_size": 200000,
                    "used_percentage": 5.0,
                },
                "cost": {},
            }
        )
        git_info = {
            "is_git": "1",
            "branch": "main",
            "staged": "0",
            "modified": "0",
            "untracked": "0",
            "remote": "",
        }
        with patch("statusline.git.get_git_info", return_value=git_info):
            result = _render_direct(payload)
        assert "claude-opus" in result
        assert "main" in result

    def test_render_direct_mode_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Test direct mode env variable is respected in main()."""
        import sys
        from io import StringIO

        payload = json.dumps(
            {
                "model": {"display_name": "claude"},
                "context_window": {"context_window_size": 200000},
                "cost": {},
            }
        )
        monkeypatch.setenv("CLAUDE_STATUSLINE_MODE", "direct")
        monkeypatch.setenv("CLAUDE_STATUSLINE_NERD_FONT", "0")

        from statusline import client

        with (
            patch.object(sys, "stdin", StringIO(payload)),
            patch("statusline.git.get_git_info", return_value={"is_git": "0"}),
            patch.object(sys, "stdout", StringIO()) as mock_out,
        ):
            client.main()
            mock_out.seek(0)
            output = mock_out.read()

        assert "claude" in output
