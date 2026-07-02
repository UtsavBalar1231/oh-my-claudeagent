"""Tests for shared state helpers in tools/_common.py."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools import _common


def test_state_dir_creates_gitignore_when_absent(tmp_git_root):
    """_state_dir() drops .omca/.gitignore with the ignore-everything-but-rules pattern."""
    gitignore = tmp_git_root / ".omca" / ".gitignore"
    assert not gitignore.exists()

    _common._state_dir(str(tmp_git_root))

    assert gitignore.exists()
    assert gitignore.read_text() == "*\n!/rules/\n"


def test_state_dir_does_not_overwrite_existing_gitignore(tmp_git_root):
    """A pre-existing .omca/.gitignore is preserved, not overwritten."""
    gitignore = tmp_git_root / ".omca" / ".gitignore"
    gitignore.write_text("custom content\n")

    _common._state_dir(str(tmp_git_root))

    assert gitignore.read_text() == "custom content\n"


def test_ensure_omca_gitignore_creates_omca_dir_if_missing(tmp_path):
    """_ensure_omca_gitignore creates .omca/ itself when it doesn't exist yet."""
    assert not (tmp_path / ".omca").exists()

    _common._ensure_omca_gitignore(str(tmp_path))

    gitignore = tmp_path / ".omca" / ".gitignore"
    assert gitignore.exists()
    assert gitignore.read_text() == "*\n!/rules/\n"
