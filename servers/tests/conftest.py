"""Shared fixtures for MCP tool testing."""

import subprocess

import pytest


@pytest.fixture
def tmp_git_root(tmp_path):
    """Create a temporary directory that looks like a git repo root.

    Uses `git init` so that _find_git_root() subprocess resolves correctly.
    Just creating .git/ dir is insufficient — git rev-parse needs a real repo.
    """
    subprocess.run(
        ["git", "init", str(tmp_path)],
        capture_output=True,
        check=True,
    )
    omca_state = tmp_path / ".omca" / "state"
    omca_state.mkdir(parents=True)
    omca_logs = tmp_path / ".omca" / "logs"
    omca_logs.mkdir(parents=True)
    return tmp_path


@pytest.fixture
def working_dir(tmp_git_root):
    """Return working_directory string for MCP tool calls."""
    return str(tmp_git_root)
