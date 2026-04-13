"""Git info fetching with caching for Claude Code statusline.

Handles branch detection (direct .git/HEAD read), porcelain v2 status parsing,
remote URL resolution, and cache management.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import time

from statusline.config import config

# Remote URL is re-fetched only when this sub-TTL (seconds) has elapsed.
_REMOTE_TTL = 60

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _git_cache_path(project_dir: str) -> str:
    h = hashlib.md5(project_dir.encode()).hexdigest()[:8]
    return os.path.join(tempfile.gettempdir(), f"claude-statusline-git-{h}")


def resolve_git_dir(project_dir: str) -> str | None:
    """Resolve the .git directory, handling worktrees (.git as file)."""
    dot_git = os.path.join(project_dir, ".git")
    if os.path.isfile(dot_git):
        # Worktree: .git file contains "gitdir: /path/to/main/.git/worktrees/NAME"
        try:
            with open(dot_git) as f:
                gitdir_line = f.read().strip()
        except OSError:
            return None
        if gitdir_line.startswith("gitdir: "):
            git_dir = gitdir_line[8:]
            if not os.path.isabs(git_dir):
                git_dir = os.path.normpath(os.path.join(project_dir, git_dir))
            return git_dir
        return None  # malformed
    if os.path.isdir(dot_git):
        return dot_git
    return None  # not a git repo


def _run_git(project_dir: str, args: list[str]) -> str:
    """Run a git command with -C project_dir, return stdout or empty string."""
    try:
        env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
        r = subprocess.run(
            ["git", "-C", project_dir, *args],
            capture_output=True,
            text=True,
            timeout=config.git_timeout,
            env=env,
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""


def _read_branch_from_head(git_dir: str) -> str | None:
    """Read branch name directly from .git/HEAD file (0.05ms vs 5ms subprocess)."""
    try:
        head_path = os.path.join(git_dir, "HEAD")
        with open(head_path) as f:
            content = f.read().strip()
        if content.startswith("ref: refs/heads/"):
            return content[16:]
        if content.startswith("ref: "):
            return content[5:]  # unusual ref, show full
        # Bare SHA = detached HEAD
        return f"(detached:{content[:7]})"
    except OSError:
        return None


def _parse_porcelain_v2(output: str) -> tuple[str | None, int, int, int]:
    """Parse git status --porcelain=v2 --branch output.

    Returns (branch_from_header, staged_count, modified_count, untracked_count).
    branch_from_header is set only for special cases (initial, detached).
    """
    branch_header: str | None = None
    staged = 0
    modified = 0
    untracked = 0

    for line in output.splitlines():
        if line.startswith("# branch.head "):
            head_val = line[14:]
            if head_val == "(initial)":
                branch_header = "(initial)"
            elif head_val == "(detached)":
                branch_header = "(detached)"
        elif line.startswith(("1 ", "2 ")):
            # Ordinary or renamed entry: "1 XY ..." or "2 XY ..."
            parts = line.split(" ", 2)
            if len(parts) >= 2:
                xy = parts[1]
                if len(xy) >= 2:
                    if xy[0] != ".":
                        staged += 1
                    if xy[1] != ".":
                        modified += 1
        elif line.startswith("u "):
            # Unmerged entry
            modified += 1
        elif line.startswith("? "):
            # Untracked
            untracked += 1

    return branch_header, staged, modified, untracked


def _fetch_git_info(project_dir: str, cached: dict[str, str] | None = None) -> dict[str, str]:
    """Fetch fresh git info using optimized approach.

    Uses direct .git/HEAD read for branch + single porcelain v2 status command,
    reducing subprocess calls from 5 to 2.

    If ``cached`` is provided, the remote URL is only re-fetched when its
    sub-TTL (_REMOTE_TTL) has expired; otherwise the cached value is reused.
    """
    git_dir = resolve_git_dir(project_dir)
    if git_dir is None:
        return {"is_git": "0"}

    # 1. Branch name from .git/HEAD (file read, ~0.05ms)
    branch = _read_branch_from_head(git_dir)
    if branch is None:
        # Fallback to subprocess if HEAD read fails
        branch = _run_git(project_dir, ["branch", "--show-current"])
        if not branch:
            short_hash = _run_git(project_dir, ["rev-parse", "--short", "HEAD"])
            branch = f"(detached:{short_hash})" if short_hash else ""

    # 2. Status counts from single porcelain v2 call
    try:
        env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
        r = subprocess.run(
            [
                "git",
                "-C",
                project_dir,
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "--branch",
                "-u",
            ],
            capture_output=True,
            text=True,
            timeout=config.git_timeout,
            env=env,
        )
        if r.returncode == 0:
            branch_header, staged, modified, untracked = _parse_porcelain_v2(r.stdout)
            # Override branch for special cases (initial repo, detached HEAD)
            if branch_header == "(initial)":
                branch = "(initial)"
            elif branch_header == "(detached)" and not branch.startswith("(detached:"):
                # HEAD file already gave us detached:SHA, keep that
                pass
        else:
            staged, modified, untracked = 0, 0, 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        staged, modified, untracked = 0, 0, 0

    # 3. Remote URL -- reuse from cache when sub-TTL is still fresh
    now = time.time()
    remote = ""
    if cached is not None:
        remote_fetched_at = cached.get("remote_fetched_at")
        if remote_fetched_at is not None:
            try:
                age = now - float(remote_fetched_at)
                if age < _REMOTE_TTL:
                    remote = cached.get("remote", "")
                else:
                    remote = _run_git(project_dir, ["remote", "get-url", "origin"])
            except (TypeError, ValueError):
                remote = _run_git(project_dir, ["remote", "get-url", "origin"])
        else:
            remote = _run_git(project_dir, ["remote", "get-url", "origin"])
    else:
        remote = _run_git(project_dir, ["remote", "get-url", "origin"])

    return {
        "is_git": "1",
        "git_dir": git_dir,
        "branch": branch,
        "staged": str(staged),
        "modified": str(modified),
        "untracked": str(untracked),
        "remote": remote,
        "remote_fetched_at": str(now),
    }


def _read_cache(cache_path: str) -> dict[str, str] | None:
    """Read the cache file. Returns None on any error."""
    try:
        with open(cache_path) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data  # type: ignore[return-value]
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return None


def _write_cache(cache_path: str, info: dict[str, str]) -> None:
    """Atomically write info dict to cache_path."""
    try:
        cache_dir = os.path.dirname(cache_path)
        fd, tmp_path = tempfile.mkstemp(dir=cache_dir, prefix=".statusline-")
        with os.fdopen(fd, "w") as f:
            json.dump(info, f)
        os.rename(tmp_path, cache_path)
    except OSError:
        pass


def _get_git_info(project_dir: str) -> dict[str, str]:
    """Get git info, using cache when fresh.

    Fallback chain:
      1. Return cached data if it is within the cache TTL.
      2. Attempt a fresh fetch; on success write cache and return fresh data.
      3. On fetch failure (timeout, exception), return stale cached data.
      4. If no cache exists at all, return {"is_git": "0"}.
    """
    cache_path = _git_cache_path(project_dir)

    # 1. Check cache freshness
    cached = _read_cache(cache_path)
    if cached is not None:
        try:
            mtime = os.path.getmtime(cache_path)
            if (time.time() - mtime) < config.cache_ttl:
                return cached
        except OSError:
            pass

    # 2. Attempt fresh fetch
    try:
        info = _fetch_git_info(project_dir, cached=cached)
        _write_cache(cache_path, info)
        return info
    except Exception:
        pass

    # 3. Stale cache fallback
    if cached is not None:
        return cached

    # 4. No cache at all
    return {"is_git": "0"}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_git_info(project_dir: str) -> dict[str, str]:
    """Get git info for a project directory, with caching.

    Public wrapper for the internal _get_git_info function.
    """
    return _get_git_info(project_dir)
