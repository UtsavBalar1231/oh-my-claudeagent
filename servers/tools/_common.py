"""Shared state helpers for omca MCP tools."""

import json
import os
import subprocess
from pathlib import Path

# --- State Constants ---

OMCA_STATE_DIR = ".omca/state"
BOULDER_FILE = "boulder.json"
EVIDENCE_FILE = "verification-evidence.json"
EVIDENCE_DIR = ".omca/evidence"
EVIDENCE_FILE_NEW = "verification-evidence.json"
NOTEPAD_DIR = ".omca/notepads"
VALID_SECTIONS = ("learnings", "issues", "decisions", "problems")
AGENT_CATALOG_FILE = "agent-catalog.json"


class ToolError(Exception):
    pass


def _resolve_session_id(session_id: str) -> str:
    """Return session_id; explicit param wins, falls back to CLAUDE_CODE_SESSION_ID env var
    injected into stdio MCP server processes. Returns empty string when neither provides a value.
    """
    if session_id:
        return session_id
    return os.environ.get("CLAUDE_CODE_SESSION_ID", "")


def _find_git_root(working_directory: str) -> str:
    """Resolve the git worktree root from a working directory."""
    cwd = working_directory if working_directory else os.getcwd()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, OSError):
        pass
    return cwd


def _state_dir(working_directory: str) -> str:
    """Return the .omca/state/ directory path."""
    root = _find_git_root(working_directory)
    return os.path.join(root, OMCA_STATE_DIR)


def _read_json(path: str) -> dict:
    """Read a JSON file, returning empty dict if missing or invalid."""
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_json(path: str, data: dict | list) -> None:
    """Atomically write JSON to a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def _notepad_new_dir(git_root: str, plan_name: str) -> str:
    """Return the canonical notepad directory for a plan under .omca/notepads/, creating it if needed."""
    d = os.path.join(git_root, NOTEPAD_DIR, plan_name)
    Path(d).mkdir(parents=True, exist_ok=True)
    return d


def _list_notepad_sections(directory: str) -> list[str]:
    """List notepad section names in a directory."""
    files = sorted(f for f in os.listdir(directory) if f.endswith(".md"))
    return [f.removesuffix(".md") for f in files]


def _evidence_new_path(git_root: str) -> str:
    """Return the canonical new evidence file path under .omca/evidence/."""
    return os.path.join(git_root, EVIDENCE_DIR, EVIDENCE_FILE_NEW)


def _load_evidence(state_dir: str) -> list[dict]:
    """Return evidence entries list; empty list on any failure.

    Reads only from the canonical path: .omca/evidence/verification-evidence.json.
    ``state_dir`` is expected to be ``<git_root>/.omca/state``.
    """
    # state_dir = <git_root>/.omca/state  →  git_root = two levels up
    git_root = os.path.dirname(os.path.dirname(state_dir))
    path = _evidence_new_path(git_root)
    try:
        data = _read_json(path)
        return data.get("entries", [])
    except Exception:
        return []
