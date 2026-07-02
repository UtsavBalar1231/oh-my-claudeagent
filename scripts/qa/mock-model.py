#!/usr/bin/env python3
"""scripts/qa/mock-model.py — deterministic mock Messages API server.

Stdlib-only HTTP listener used by session-smoke.sh (task 6, plan
omca-deferred-hardening-v2-14) once the mock-model spike verdict was SUPPORTED
(.omca/notes/mock-model-verdict.md). It stands in for api.anthropic.com so a
headless `claude -p` turn can complete without real API spend.

Proven env contract (from the spike): `claude` is invoked with
ANTHROPIC_BASE_URL scoped to the subprocess only; it appends its normal request
path, so requests land at <base>/v1/messages?beta=true carrying a real
Authorization header (subscription OAuth flows through unchanged) and a JSON
body with a `messages` array. Empirically the CLI's own request never sets
`stream: true` (verified against a live probe on 2026-07-02: --output-format
stream-json still produces a non-streaming API request, converted to the CLI's
own event wire format downstream) -- but the Messages API itself supports both
modes, so this mock branches on the request's `stream` field for protocol
fidelity rather than hardcoding the one shape observed.

Response is a single deterministic, tool-free assistant turn: the fixed text
below, never varied, so every consumer (session-smoke assertions, --self-test)
can assert on an exact string.

Usage:
  python3 mock-model.py --port <N> [--access-log <path>]
  python3 mock-model.py --self-test
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

RESPONSE_TEXT = "ok"
MOCK_MODEL_ID = "claude-mock"
# Header names that could carry a credential; log presence only, never the value.
CREDENTIAL_HEADERS = ("Authorization", "X-Api-Key")


def build_json_response() -> dict[str, Any]:
    """Non-streaming Messages API response shape, proven against a real `claude -p`
    turn (task-1 spike methodology, re-run for this task): id/type/role/content/
    model/stop_reason/stop_sequence/usage is sufficient for the CLI's SDK client
    to accept the turn."""
    return {
        "id": "msg_mock_static",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": RESPONSE_TEXT}],
        "model": MOCK_MODEL_ID,
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


def build_sse_events() -> list[tuple[str, dict[str, Any]]]:
    """SSE event/data pairs for the streaming Messages API shape: message_start,
    one content_block_start/delta/stop cycle for the single fixed-text block,
    message_delta carrying stop_reason, then message_stop."""
    return [
        (
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_mock_static",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": MOCK_MODEL_ID,
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 1, "output_tokens": 0},
                },
            },
        ),
        (
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        (
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": RESPONSE_TEXT},
            },
        ),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 1},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]


class MockHandler(BaseHTTPRequestHandler):
    access_log_path: str | None = None
    access_log_lock = threading.Lock()

    def _log_request(self, mode: str) -> None:
        if not self.access_log_path:
            return
        entry = {
            "ts": self.log_date_time_string(),
            "client": self.client_address[0],
            "method": "POST",
            "path": self.path,
            "mode": mode,
            "has_credential": any(h in self.headers for h in CREDENTIAL_HEADERS),
        }
        with self.access_log_lock, open(self.access_log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if not self.path.startswith("/v1/messages"):
            self.send_error(404, "mock-model.py only serves /v1/messages")
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {}

        if payload.get("stream"):
            self._log_request("sse")
            self._write_sse()
        else:
            self._log_request("json")
            self._write_json()

    def _write_json(self) -> None:
        body = json.dumps(build_json_response()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for event, data in build_sse_events():
            frame = f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()
            self.wfile.write(frame)
            self.wfile.flush()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # the access-log file (JSONL) is the record; suppress stderr noise.


def run_server(port: int, access_log_path: str | None) -> None:
    MockHandler.access_log_path = access_log_path
    server = ThreadingHTTPServer(("127.0.0.1", port), MockHandler)
    print(server.server_address[1], flush=True)

    stop_event = threading.Event()

    def _handle_signal(signum: int, frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    stop_event.wait()
    server.shutdown()
    server.server_close()


def self_test() -> int:
    """In-process urllib probe (no subprocess `claude`): sends one non-streaming
    and one streaming request, validates the JSON shape and the exact SSE frame
    sequence. This is the fast, hermetic check; the real `claude -p` end-to-end
    proof lives in session-smoke.sh's mock-backed path."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    MockHandler.access_log_path = None
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    failures: list[str] = []
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/messages?beta=true",
            data=json.dumps({"model": "x", "messages": []}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
        if body.get("content") != [{"type": "text", "text": RESPONSE_TEXT}]:
            failures.append(f"non-streaming content mismatch: {body.get('content')!r}")
        if body.get("role") != "assistant" or body.get("stop_reason") != "end_turn":
            failures.append(f"non-streaming envelope fields wrong: {body!r}")

        req2 = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/messages?beta=true",
            data=json.dumps({"model": "x", "messages": [], "stream": True}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req2, timeout=5) as resp2:
            raw = resp2.read().decode()
        actual_sequence = [
            line.split(": ", 1)[1]
            for line in raw.split("\n")
            if line.startswith("event: ")
        ]
        expected_sequence = [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop",
        ]
        if actual_sequence != expected_sequence:
            failures.append(f"SSE frame sequence mismatch: {actual_sequence!r}")
    finally:
        server.shutdown()
        server.server_close()

    if failures:
        for f in failures:
            print(f"[mock-model --self-test] FAIL: {f}", file=sys.stderr)
        return 1
    print(
        "[mock-model --self-test] PASS: non-streaming JSON shape and SSE frame sequence both valid"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port", type=int, default=0, help="0 = ephemeral, assigned by the OS"
    )
    parser.add_argument(
        "--access-log",
        type=str,
        default=None,
        help="JSONL request log path (omit to skip logging)",
    )
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    run_server(args.port, args.access_log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
