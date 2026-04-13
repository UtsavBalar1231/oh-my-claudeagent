"""Tests for statusline.git parsing functions."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from statusline.git import (
    _get_git_info,
    _git_cache_path,
    _parse_porcelain_v2,
    _read_branch_from_head,
    _write_cache,
    resolve_git_dir,
)

# ---------------------------------------------------------------------------
# _parse_porcelain_v2
# ---------------------------------------------------------------------------


class TestParsePorcelainV2:
    def test_clean_repo(self) -> None:
        output = "# branch.oid abc123\n# branch.head main\n"
        branch_header, staged, modified, untracked = _parse_porcelain_v2(output)
        assert branch_header is None
        assert staged == 0
        assert modified == 0
        assert untracked == 0

    def test_initial_repo(self) -> None:
        output = "# branch.oid (initial)\n# branch.head (initial)\n"
        branch_header, _staged, _modified, _untracked = _parse_porcelain_v2(output)
        assert branch_header == "(initial)"

    def test_detached_head(self) -> None:
        output = "# branch.oid abc123\n# branch.head (detached)\n"
        branch_header, _staged, _modified, _untracked = _parse_porcelain_v2(output)
        assert branch_header == "(detached)"

    def test_staged_file(self) -> None:
        # "1 M. ..." means staged (X=M), not modified in worktree (Y=.)
        output = "# branch.head main\n1 M. N... 100644 100644 100644 a b file.txt\n"
        _, staged, modified, _untracked = _parse_porcelain_v2(output)
        assert staged == 1
        assert modified == 0

    def test_modified_file(self) -> None:
        # "1 .M ..." means not staged, modified in worktree
        output = "# branch.head main\n1 .M N... 100644 100644 100644 a b file.txt\n"
        _, staged, modified, _untracked = _parse_porcelain_v2(output)
        assert staged == 0
        assert modified == 1

    def test_untracked_file(self) -> None:
        output = "# branch.head main\n? untracked_file.txt\n"
        _, _staged, _modified, untracked = _parse_porcelain_v2(output)
        assert untracked == 1

    def test_mixed_status(self) -> None:
        output = (
            "# branch.head main\n"
            "1 MM N... 100644 100644 100644 a b file1.txt\n"  # staged+modified
            "1 .M N... 100644 100644 100644 a b file2.txt\n"  # modified
            "? new_file.txt\n"
        )
        _, staged, modified, untracked = _parse_porcelain_v2(output)
        assert staged == 1
        assert modified == 2  # MM counts worktree, .M counts worktree
        assert untracked == 1

    def test_unmerged_entry(self) -> None:
        output = "# branch.head main\nu UU N... 100644 100644 100644 100644 a b c file.txt\n"
        _, _staged, modified, _untracked = _parse_porcelain_v2(output)
        assert modified == 1

    def test_renamed_entry(self) -> None:
        # "2" prefix = renamed/copied
        output = "# branch.head main\n2 R. N... 100644 100644 100644 a b R100 new.txt\told.txt\n"
        _, staged, _modified, _untracked = _parse_porcelain_v2(output)
        assert staged == 1


# ---------------------------------------------------------------------------
# _read_branch_from_head
# ---------------------------------------------------------------------------


class TestReadBranchFromHead:
    def test_normal_branch(self, tmp_path: Path) -> None:
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        head_file = git_dir / "HEAD"
        head_file.write_text("ref: refs/heads/main\n")
        result = _read_branch_from_head(str(git_dir))
        assert result == "main"

    def test_feature_branch(self, tmp_path: Path) -> None:
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        (git_dir / "HEAD").write_text("ref: refs/heads/feature/my-feature\n")
        result = _read_branch_from_head(str(git_dir))
        assert result == "feature/my-feature"

    def test_detached_head(self, tmp_path: Path) -> None:
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        sha = "abc1234def5678901234567890abcdef01234567"
        (git_dir / "HEAD").write_text(sha + "\n")
        result = _read_branch_from_head(str(git_dir))
        assert result is not None
        assert "detached" in result
        assert sha[:7] in result

    def test_missing_head_file(self, tmp_path: Path) -> None:
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        # No HEAD file
        result = _read_branch_from_head(str(git_dir))
        assert result is None

    def test_unusual_ref(self, tmp_path: Path) -> None:
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        (git_dir / "HEAD").write_text("ref: refs/tags/v1.0\n")
        result = _read_branch_from_head(str(git_dir))
        assert result == "refs/tags/v1.0"


# ---------------------------------------------------------------------------
# resolve_git_dir
# ---------------------------------------------------------------------------


class TestResolveGitDir:
    def test_regular_repo(self, tmp_path: Path) -> None:
        git_dir = tmp_path / ".git"
        git_dir.mkdir()
        result = resolve_git_dir(str(tmp_path))
        assert result == str(git_dir)

    def test_not_a_git_repo(self, tmp_path: Path) -> None:
        result = resolve_git_dir(str(tmp_path))
        assert result is None

    def test_worktree_git_file(self, tmp_path: Path) -> None:
        # Create a main repo
        main_repo = tmp_path / "main_repo"
        main_repo.mkdir()
        main_git = main_repo / ".git"
        main_git.mkdir()

        # Create worktree dir with .git file
        worktree = tmp_path / "worktree"
        worktree.mkdir()
        wt_git_dir = main_git / "worktrees" / "wt"
        wt_git_dir.mkdir(parents=True)
        git_file = worktree / ".git"
        git_file.write_text(f"gitdir: {wt_git_dir}\n")

        result = resolve_git_dir(str(worktree))
        assert result == str(wt_git_dir)

    def test_malformed_git_file(self, tmp_path: Path) -> None:
        git_file = tmp_path / ".git"
        git_file.write_text("not a gitdir line\n")
        result = resolve_git_dir(str(tmp_path))
        assert result is None


# ---------------------------------------------------------------------------
# _get_git_info stale-cache fallback
# ---------------------------------------------------------------------------


class TestGetGitInfoStaleCacheFallback:
    """Verify that _get_git_info returns stale cache when fetch fails."""

    def test_returns_stale_cache_on_fetch_failure(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When the cache is stale and the fetch raises, stale data is returned."""
        project_dir = str(tmp_path)

        # Pre-populate a stale cache entry
        stale_data = {
            "is_git": "1",
            "git_dir": "/stale/path/.git",
            "branch": "stale-branch",
            "staged": "0",
            "modified": "0",
            "untracked": "0",
            "remote": "",
            "remote_fetched_at": str(time.time()),
        }
        cache_path = _git_cache_path(project_dir)
        _write_cache(cache_path, stale_data)

        # Force cache to appear expired (mtime in the distant past)
        old_mtime = time.time() - 3600
        os.utime(cache_path, (old_mtime, old_mtime))

        # Make _fetch_git_info raise to simulate a failure
        def failing_fetch(pd: str, cached=None) -> dict:
            raise RuntimeError("simulated git failure")

        monkeypatch.setattr("statusline.git._fetch_git_info", failing_fetch)

        result = _get_git_info(project_dir)

        # Should get stale branch back, not {"is_git": "0"}
        assert result["branch"] == "stale-branch"
        assert result["is_git"] == "1"

    def test_returns_is_git_zero_when_no_cache_and_fetch_fails(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When there is no cache and fetch fails, fallback is {"is_git": "0"}."""
        project_dir = str(tmp_path / "nonexistent_project")

        def failing_fetch(pd: str, cached=None) -> dict:
            raise RuntimeError("simulated git failure")

        monkeypatch.setattr("statusline.git._fetch_git_info", failing_fetch)

        result = _get_git_info(project_dir)
        assert result == {"is_git": "0"}

    def test_fresh_cache_is_returned_without_fetch(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When cache is within TTL, fetch is not called."""
        project_dir = str(tmp_path)
        fresh_data = {
            "is_git": "1",
            "branch": "cached-branch",
            "staged": "0",
            "modified": "0",
            "untracked": "0",
            "remote": "",
            "remote_fetched_at": str(time.time()),
        }
        cache_path = _git_cache_path(project_dir)
        _write_cache(cache_path, fresh_data)
        # mtime is just now, so TTL is not exceeded

        fetch_called = []

        def spy_fetch(pd: str, cached=None) -> dict:
            fetch_called.append(True)
            return {"is_git": "0"}

        monkeypatch.setattr("statusline.git._fetch_git_info", spy_fetch)

        result = _get_git_info(project_dir)
        assert result["branch"] == "cached-branch"
        assert not fetch_called, "fetch should not be called when cache is fresh"
