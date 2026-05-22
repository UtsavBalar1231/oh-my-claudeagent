"""Tests for _legacy_path_fallback helper."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools._common import _legacy_path_fallback


def test_returns_new_path_when_both_exist(tmp_path):
    """New path wins when both files exist."""
    new = tmp_path / "new.json"
    legacy = tmp_path / "legacy.json"
    new.write_text("{}")
    legacy.write_text("{}")
    assert _legacy_path_fallback(str(new), str(legacy)) == str(new)


def test_returns_legacy_path_when_only_legacy_exists(tmp_path):
    """Falls back to legacy when only legacy file exists."""
    new = tmp_path / "new.json"
    legacy = tmp_path / "legacy.json"
    legacy.write_text("{}")
    assert _legacy_path_fallback(str(new), str(legacy)) == str(legacy)


def test_returns_new_path_when_neither_exists(tmp_path):
    """Returns new_path as canonical write target when neither exists."""
    new = tmp_path / "new.json"
    legacy = tmp_path / "legacy.json"
    assert _legacy_path_fallback(str(new), str(legacy)) == str(new)
