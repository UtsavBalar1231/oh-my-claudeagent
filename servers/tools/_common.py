"""Shared state helpers for omca MCP tools."""

import json
import os
import subprocess

# --- State Constants ---

OMCA_STATE_DIR = ".omca/state"
BOULDER_FILE = "boulder.json"
EVIDENCE_FILE = "verification-evidence.json"
RALPH_STATE_FILE = "ralph-state.json"
ULTRAWORK_STATE_FILE = "ultrawork-state.json"
PENDING_FINAL_VERIFY_FILE = "pending-final-verify.json"
NOTEPADS_DIR = "notepads"
VALID_SECTIONS = ("learnings", "issues", "decisions", "problems")
AGENT_CATALOG_FILE = "agent-catalog.json"


class ToolError(Exception):
    pass


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


def _notepad_dir(state: str, plan_name: str) -> str:
    """Return the notepad directory for a plan, creating it if needed."""
    d = os.path.join(state, NOTEPADS_DIR, plan_name)
    os.makedirs(d, exist_ok=True)
    return d


def _list_notepad_sections(directory: str) -> list[str]:
    """List notepad section names in a directory."""
    files = sorted(f for f in os.listdir(directory) if f.endswith(".md"))
    return [f.removesuffix(".md") for f in files]
