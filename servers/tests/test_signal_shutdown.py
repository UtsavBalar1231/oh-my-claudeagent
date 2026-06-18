import json
import os
import subprocess
import sys
import time
from pathlib import Path


def _plugin_root() -> Path:
    env = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env:
        return Path(env)
    out = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True)
    return Path(out.strip())


def test_omca_mcp_exits_promptly_on_sigterm_after_initialize() -> None:
    root = _plugin_root()
    proc = subprocess.Popen(
        [sys.executable, str(root / "servers" / "omca-mcp.py")],
        cwd=root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        assert proc.stdin is not None
        assert proc.stdout is not None
        proc.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {"name": "shutdown-test", "version": "0"},
                    },
                }
            )
            + "\n"
        )
        proc.stdin.flush()
        assert proc.stdout.readline(), "server did not respond to initialize"
        proc.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        proc.stdin.flush()

        time.sleep(0.2)
        proc.terminate()

        assert proc.wait(timeout=2) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)
