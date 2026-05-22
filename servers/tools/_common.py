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
RALPH_STATE_FILE = "ralph-state.json"
ULTRAWORK_STATE_FILE = "ultrawork-state.json"
PENDING_FINAL_VERIFY_FILE = "pending-final-verify.json"
NOTEPADS_DIR = "notepads"
NOTEPAD_DIR = ".omca/notepads"
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


def _legacy_path_fallback(new_path: str, legacy_path: str) -> str:
    """Return the preferred path for one-release transition reads.

    Priority:
    1. ``new_path`` if the file exists there — canonical location wins.
    2. ``legacy_path`` if the file exists there — backwards-compat read.
    3. ``new_path`` when neither exists — callers write to the new location.
    """
    if os.path.exists(new_path):
        return new_path
    if os.path.exists(legacy_path):
        return legacy_path
    return new_path


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
    """Return the legacy notepad directory for a plan (under .omca/state/notepads/)."""
    return os.path.join(state, NOTEPADS_DIR, plan_name)


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


def _evidence_legacy_path(state_dir: str) -> str:
    """Return the legacy evidence file path under .omca/state/."""
    return os.path.join(state_dir, EVIDENCE_FILE)


def _load_evidence(state_dir: str) -> list[dict]:
    """Return evidence entries list; empty list on any failure.

    Reads via legacy-path fallback: prefers new path (.omca/evidence/),
    falls back to legacy (.omca/state/) if new path absent.
    ``state_dir`` is expected to be ``<git_root>/.omca/state``.
    """
    # state_dir = <git_root>/.omca/state  →  git_root = two levels up
    git_root = os.path.dirname(os.path.dirname(state_dir))
    new_path = _evidence_new_path(git_root)
    legacy_path = _evidence_legacy_path(state_dir)
    path = _legacy_path_fallback(new_path, legacy_path)
    try:
        data = _read_json(path)
        return data.get("entries", [])
    except Exception:
        return []


_MODE_FILES: dict[str, str] = {
    "ralph": RALPH_STATE_FILE,
    "ultrawork": ULTRAWORK_STATE_FILE,
    "boulder": BOULDER_FILE,
    "final_verify": PENDING_FINAL_VERIFY_FILE,
    "evidence": EVIDENCE_FILE,
}


def _clear_mode_files(state: str, modes: list[str]) -> list[str]:
    """Remove state files for the named modes; return list of actually-cleared mode names."""
    cleared: list[str] = []
    for label in modes:
        if label == "evidence":
            # Evidence lives at the new path; try new then legacy for removal.
            # state = <git_root>/.omca/state  →  git_root = two levels up
            git_root = os.path.dirname(os.path.dirname(state))
            paths_to_try = [
                _evidence_new_path(git_root),
                _evidence_legacy_path(state),
            ]
            removed = False
            for path in paths_to_try:
                try:
                    os.remove(path)
                    removed = True
                except FileNotFoundError:
                    pass
            if removed:
                cleared.append(label)
            continue
        filename = _MODE_FILES.get(label)
        if not filename:
            continue
        path = os.path.join(state, filename)
        try:
            os.remove(path)
            cleared.append(label)
        except FileNotFoundError:
            pass
    return cleared
