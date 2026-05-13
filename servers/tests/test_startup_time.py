"""Bench: warm startup time for the omca MCP server.

Validates that `alwaysLoad: true` on the omca MCP server is safe given the
platform's 5s startup cap. The threshold below (2.0s p95) is the OMCA-internal
safety margin — well under the platform cap.

Reference: foreground bench during v2.2.0 plan authoring measured
p95=0.287s on this user's machine (uv 0.10.10, Python 3.14.5).
"""
from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

WARM_RUNS = 5
P95_THRESHOLD_SECONDS = 2.0
HANDSHAKE_BYTES = (
    b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":'
    b'{"protocolVersion":"2024-11-05","capabilities":{},'
    b'"clientInfo":{"name":"bench","version":"1"}}}\n'
    b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
    b'{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'
)


def _plugin_root() -> Path:
    env = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env:
        return Path(env)
    # Fall back to repo root via git
    out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True)
    return Path(out.strip())


def _one_run(plugin_root: Path) -> float | None:
    """Spawn the MCP server and time wall-clock to first tools/list response."""
    servers = plugin_root / "servers"
    cmd = ["uv", "run", "--project", str(servers), str(servers / "omca-mcp.py")]
    t0 = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    assert proc.stdin is not None
    proc.stdin.write(HANDSHAKE_BYTES)
    proc.stdin.flush()
    deadline = t0 + 15
    buf = b""
    while time.monotonic() < deadline:
        chunk = proc.stdout.read1(65536) if hasattr(proc.stdout, "read1") else proc.stdout.read(65536)
        if not chunk:
            break
        buf += chunk
        if b'"id":2' in buf:
            elapsed = time.monotonic() - t0
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                proc.terminate()
            except Exception:
                pass
            return elapsed
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.terminate()
    except Exception:
        pass
    return None


def test_omca_mcp_warm_startup_under_threshold() -> None:
    plugin_root = _plugin_root()
    # Primer run discarded — populates uv cache
    primer = _one_run(plugin_root)
    assert primer is not None, "primer run timed out"

    warm = []
    for _ in range(WARM_RUNS):
        t = _one_run(plugin_root)
        assert t is not None, "warm run timed out"
        warm.append(t)

    warm_sorted = sorted(warm)
    p95 = warm_sorted[int(len(warm_sorted) * 0.95)] if len(warm_sorted) > 1 else warm_sorted[0]
    med = statistics.median(warm_sorted)

    summary = {
        "primer_seconds": round(primer, 3),
        "warm_runs": len(warm),
        "median": round(med, 3),
        "p95": round(p95, 3),
        "max": round(max(warm_sorted), 3),
        "threshold_seconds": P95_THRESHOLD_SECONDS,
    }
    # Print so pytest -s users see the numbers
    print(json.dumps(summary, indent=2), file=sys.stderr)
    assert p95 <= P95_THRESHOLD_SECONDS, (
        f"omca MCP warm-startup p95={p95:.3f}s exceeds {P95_THRESHOLD_SECONDS}s threshold; "
        f"reconsider alwaysLoad: true in .mcp.json"
    )
