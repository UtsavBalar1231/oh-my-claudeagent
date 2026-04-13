"""Tests for filesystem MCP tools."""

import os

import pytest

import tools.filesystem as fs_module


def _get_tools():
    """Extract tool functions from the filesystem module by calling register() on a mock."""
    from unittest.mock import MagicMock

    captured = {}
    mock_mcp = MagicMock()

    def tool_decorator(*args, **kwargs):
        def wrapper(fn):
            captured[fn.__name__] = fn
            return fn

        # Called as @mcp.tool() or @mcp.tool(annotations=...)
        if args and callable(args[0]):
            fn = args[0]
            captured[fn.__name__] = fn
            return fn
        return wrapper

    mock_mcp.tool = tool_decorator
    fs_module.register(mock_mcp)
    return captured


@pytest.fixture
def tools():
    return _get_tools()


# --- Happy path ---


def test_read_normal_file_with_line_numbers(tools, tmp_path):
    """file_read returns numbered lines for a normal text file."""
    f = tmp_path / "hello.txt"
    f.write_text("line one\nline two\nline three\n")
    result = tools["file_read"](path=str(f))
    # Line numbers use cat -n style: right-aligned 6 chars + tab
    assert "     1\tline one" in result
    assert "     2\tline two" in result
    assert "     3\tline three" in result


def test_read_with_offset_and_limit(tools, tmp_path):
    """file_read with offset=5 and limit=3 returns the correct 3-line slice."""
    lines = [f"line {i}" for i in range(20)]
    f = tmp_path / "big.txt"
    f.write_text("\n".join(lines))
    result = tools["file_read"](path=str(f), offset=5, limit=3)
    # offset=5 → lines[5:8] → "line 5", "line 6", "line 7"
    assert "line 5" in result
    assert "line 6" in result
    assert "line 7" in result
    # Should not include line 4 or line 8
    assert "line 4" not in result
    assert "line 8" not in result


def test_read_entire_file_with_limit_zero(tools, tmp_path):
    """file_read with limit=0 returns all lines for a small file."""
    lines = [f"entry {i}" for i in range(50)]
    f = tmp_path / "all.txt"
    f.write_text("\n".join(lines))
    result = tools["file_read"](path=str(f), limit=0)
    assert "entry 0" in result
    assert "entry 49" in result
    assert "50 lines total" in result


def test_large_file_chunked_read_allowed(tools, tmp_path):
    """file_read with offset+limit on a >3MB file is allowed (size guard only blocks limit=0)."""
    big_file = tmp_path / "big.bin"
    # Write just over 3MB of text lines
    chunk = ("x" * 99 + "\n") * 1000  # ~100KB per block
    big_file.write_text(chunk * 31)  # ~3.1MB
    # Chunked read must succeed even though file is >2MB
    result = tools["file_read"](path=str(big_file), offset=0, limit=10)
    assert "too large" not in result
    assert "     1\t" in result


# --- Edge cases ---


def test_offset_past_eof_returns_descriptive_message(tools, tmp_path):
    """file_read with offset past file length returns a descriptive message."""
    f = tmp_path / "short.txt"
    f.write_text("only one line\n")
    result = tools["file_read"](path=str(f), offset=100)
    assert "offset" in result
    assert "exceeds" in result


def test_empty_file_returns_empty_message(tools, tmp_path):
    """file_read on an empty file returns '(empty file)'."""
    f = tmp_path / "empty.txt"
    f.write_text("")
    result = tools["file_read"](path=str(f))
    assert "(empty file)" in result


def test_symlink_followed_to_target_file(tools, tmp_path):
    """file_read follows symlinks to the target file."""
    target = tmp_path / "target.txt"
    target.write_text("symlinked content\n")
    link = tmp_path / "link.txt"
    link.symlink_to(target)
    result = tools["file_read"](path=str(link))
    assert "symlinked content" in result


def test_encoding_fallback_to_latin1(tools, tmp_path):
    """file_read falls back to latin-1 for non-UTF-8 encoded files."""
    f = tmp_path / "latin.txt"
    # Write bytes that are valid latin-1 but invalid UTF-8
    f.write_bytes(b"caf\xe9\n")  # "café" in latin-1
    result = tools["file_read"](path=str(f), encoding="utf-8")
    assert "encoding fallback" in result
    assert "latin-1" in result


# --- Error cases ---


def test_file_not_found_returns_error_string(tools, tmp_path):
    """file_read returns an error string (not an exception) for missing files."""
    missing = str(tmp_path / "nonexistent.txt")
    result = tools["file_read"](path=missing)
    assert "not found" in result.lower() or "File not found" in result


def test_path_is_directory_returns_error_string(tools, tmp_path):
    """file_read returns an error string when path is a directory."""
    result = tools["file_read"](path=str(tmp_path))
    assert "directory" in result.lower()


def test_binary_file_detected_returns_error(tools, tmp_path):
    """file_read rejects binary files detected via null-byte scan."""
    f = tmp_path / "binary.bin"
    f.write_bytes(b"\x00\x01\x02\x03binary content")
    result = tools["file_read"](path=str(f))
    assert "Binary file detected" in result


def test_large_file_with_limit_zero_rejected(tools, tmp_path):
    """file_read with limit=0 on a >3MB file returns a size error."""
    big_file = tmp_path / "huge.txt"
    # Write just over 3MB of text (3MB = 3,145,728 bytes)
    chunk = ("y" * 99 + "\n") * 1000  # ~100KB per block
    big_file.write_text(chunk * 32)  # ~3.2MB > 3MB threshold
    result = tools["file_read"](path=str(big_file), limit=0)
    assert "too large" in result
    assert "Use offset and limit" in result


def test_fifo_path_rejected(tools, tmp_path):
    """file_read rejects FIFOs to prevent MCP server hangs."""
    fifo_path = tmp_path / "myfifo"
    os.mkfifo(str(fifo_path))
    result = tools["file_read"](path=str(fifo_path))
    assert "Not a regular file" in result


def test_denied_path_returns_access_denied(tools, tmp_path):
    """file_read rejects paths that match the sensitive file denylist."""
    # Create a fake .env file in tmp_path — the denylist matches **/.env
    env_file = tmp_path / ".env"
    env_file.write_text("SECRET=hunter2\n")
    result = tools["file_read"](path=str(env_file))
    assert "Access denied" in result


# --- Token estimation footer ---


def test_token_estimate_in_footer(tools, tmp_path):
    """file_read result contains token estimate marker (~) and 'tokens' in footer."""
    f = tmp_path / "sample.txt"
    f.write_text("hello world\n" * 10)
    result = tools["file_read"](path=str(f))
    assert "~" in result
    assert "tokens" in result


def test_token_estimate_uses_file_size(tools, tmp_path):
    """file_read footer shows ~200 tokens for an ~800-byte file (800 // 4 = 200)."""
    f = tmp_path / "sized.txt"
    # Write exactly 800 bytes: 799 'a' chars + newline
    f.write_bytes(b"a" * 799 + b"\n")
    result = tools["file_read"](path=str(f))
    assert "~200 tokens" in result


# --- Audit log ---


def test_audit_log_entry_written(tools, tmp_path, monkeypatch):
    """file_read writes an audit log entry to .omca/logs/file-access.jsonl."""
    monkeypatch.chdir(tmp_path)
    f = tmp_path / "readable.txt"
    f.write_text("audit test\n")
    tools["file_read"](path=str(f))
    log_path = tmp_path / ".omca" / "logs" / "file-access.jsonl"
    assert log_path.exists(), "Audit log was not created"
    content = log_path.read_text()
    assert str(f) in content
    assert '"allowed": true' in content
