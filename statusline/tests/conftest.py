"""Shared pytest fixtures for statusline tests."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_tmpdir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Redirect tempfile.gettempdir() to the per-test tmp_path."""
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
