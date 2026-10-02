"""Width handling of bin/omca-subagent-statusline."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

BIN = Path(__file__).resolve().parents[2] / "bin" / "omca-subagent-statusline"


def _content(payload: dict, columns_env: str | None) -> str:
    env = {k: v for k, v in os.environ.items() if k != "COLUMNS"}
    if columns_env is not None:
        env["COLUMNS"] = columns_env
    result = subprocess.run(
        [sys.executable, str(BIN)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    return json.loads(result.stdout)["content"]


def test_payload_columns_clamp_the_row() -> None:
    payload = {"columns": 40, "tasks": [{"id": "t1", "name": "a" * 50}]}
    assert _content(payload, None) == "a" * 39 + "…"


def test_columns_env_applies_when_the_payload_has_none() -> None:
    payload = {"tasks": [{"id": "t1", "name": "x" * 60}]}
    assert _content(payload, "30") == "x" * 29 + "…"


def test_payload_columns_win_over_the_columns_env() -> None:
    payload = {"columns": 40, "tasks": [{"id": "t1", "name": "a" * 50}]}
    assert _content(payload, "30") == "a" * 39 + "…"
