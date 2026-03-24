"""Tests for AST MCP tools (ast_search, ast_replace, ast_find_rule, ast_dump_tree, ast_test_rule)."""

import json
from unittest.mock import MagicMock

import pytest

import tools.ast as ast_module
from tools._common import ToolError


def _get_tools():
    """Extract tool functions from ast module."""
    captured = {}
    mock_mcp = MagicMock()

    def tool_decorator(*args, **kwargs):
        def wrapper(fn):
            captured[fn.__name__] = fn
            return fn

        if args and callable(args[0]):
            fn = args[0]
            captured[fn.__name__] = fn
            return fn
        return wrapper

    mock_mcp.tool = tool_decorator
    ast_module.register(mock_mcp)
    return captured


@pytest.fixture(autouse=True)
def set_sg_bin():
    """Set a fake binary path so run_command's guard passes."""
    original = ast_module._SG_BIN
    ast_module._SG_BIN = "/fake/ast-grep"
    yield
    ast_module._SG_BIN = original


@pytest.fixture
def tools():
    return _get_tools()


def _make_process(returncode=0, stdout=b"", stderr=b""):
    """Build a fake CompletedProcess-like object."""
    proc = MagicMock()
    proc.returncode = returncode
    proc.stdout = stdout
    proc.stderr = stderr
    return proc


# --- ast_search ---


def test_ast_search_returns_parsed_results(tools, mocker):
    """ast_search returns formatted output from mocked subprocess."""
    matches = [
        {
            "file": "main.py",
            "text": "print('hello')",
            "lines": "print('hello')",
            "range": {
                "start": {"line": 0, "column": 0},
                "end": {"line": 0, "column": 14},
            },
        }
    ]
    mock_proc = _make_process(stdout=json.dumps(matches).encode())
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_search"](
        pattern="print($$$A)",
        lang="python",
        paths=["."],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )
    assert "main.py" in result
    assert "1:1" in result  # line 0+1=1, col 0+1=1


def test_ast_search_no_matches(tools, mocker):
    """ast_search returns 'No matches found' when stdout is empty."""
    mock_proc = _make_process(stdout=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_search"](
        pattern="nonexistent_pattern()",
        lang="python",
        paths=["."],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )
    assert "No matches found" in result


def test_ast_search_subprocess_error(tools, mocker):
    """ast_search raises ToolError on non-zero exit with stderr."""
    mock_proc = _make_process(
        returncode=2, stdout=b"", stderr=b"fatal: something went wrong"
    )
    mocker.patch("subprocess.run", return_value=mock_proc)

    with pytest.raises(ToolError, match="ast-grep error"):
        tools["ast_search"](
            pattern="$X",
            lang="python",
            paths=["."],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )


# --- ast_replace ---


def test_ast_replace_dry_run(tools, mocker):
    """ast_replace with dry_run=True returns replacement preview from mocked subprocess."""
    matches = [
        {
            "file": "app.py",
            "text": "old_func(x)",
            "lines": "old_func(x)",
            "range": {
                "start": {"line": 5, "column": 0},
                "end": {"line": 5, "column": 11},
            },
        }
    ]
    mock_proc = _make_process(stdout=json.dumps(matches).encode())
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_replace"](
        pattern="old_func($X)",
        rewrite="new_func($X)",
        lang="python",
        paths=["."],
        globs=None,
        dry_run=True,
    )
    assert "app.py" in result
    assert "DRY RUN" in result
    assert "replacement" in result


def test_ast_replace_no_matches(tools, mocker):
    """ast_replace returns no-match message when stdout is empty."""
    mock_proc = _make_process(stdout=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_replace"](
        pattern="no_such_func($X)",
        rewrite="other_func($X)",
        lang="python",
        paths=["."],
        globs=None,
        dry_run=True,
    )
    assert "No matches" in result


# --- ast_find_rule ---


def test_ast_find_rule_returns_results(tools, mocker):
    """ast_find_rule returns formatted scan results from mocked subprocess."""
    matches = [
        {
            "file": "src/main.py",
            "text": "import os",
            "lines": "import os",
            "ruleId": "find-imports",
            "severity": "info",
            "range": {
                "start": {"line": 0, "column": 0},
                "end": {"line": 0, "column": 9},
            },
        }
    ]
    mock_proc = _make_process(stdout=json.dumps(matches).encode())
    mocker.patch("subprocess.run", return_value=mock_proc)

    rule_yaml = "id: find-imports\nlanguage: python\nrule:\n  pattern: import $MOD\n"
    result = tools["ast_find_rule"](
        rule_yaml=rule_yaml,
        paths=["."],
        max_results=500,
        output_format="text",
    )
    assert "src/main.py" in result
    assert "find-imports" in result


def test_ast_find_rule_no_matches(tools, mocker):
    """ast_find_rule returns 'No matches found' when stdout is empty."""
    mock_proc = _make_process(stdout=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    rule_yaml = "id: noop\nlanguage: python\nrule:\n  pattern: doesnt_exist()\n"
    result = tools["ast_find_rule"](
        rule_yaml=rule_yaml,
        paths=["."],
        max_results=500,
        output_format="text",
    )
    assert "No matches found" in result


# --- ast_dump_tree ---


def test_ast_dump_tree_returns_tree(tools, mocker):
    """ast_dump_tree returns the stderr tree output from mocked subprocess."""
    tree_output = b"expression_statement\n  call\n    identifier print\n"
    mock_proc = _make_process(stderr=tree_output)
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_dump_tree"](
        code="print('hello')",
        language="python",
        format="cst",
    )
    assert "expression_statement" in result or "call" in result


def test_ast_dump_tree_empty_output(tools, mocker):
    """ast_dump_tree returns helpful message when no tree output."""
    mock_proc = _make_process(stderr=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_dump_tree"](
        code="",
        language="python",
        format="cst",
    )
    assert "No syntax tree output" in result


# --- ast_test_rule ---


def test_ast_test_rule_returns_matches(tools, mocker):
    """ast_test_rule returns scan results when the rule matches."""
    matches = [
        {
            "file": "<stdin>",
            "text": "print('x')",
            "lines": "print('x')",
            "ruleId": "test",
            "severity": "info",
            "range": {
                "start": {"line": 0, "column": 0},
                "end": {"line": 0, "column": 10},
            },
        }
    ]
    mock_proc = _make_process(stdout=json.dumps(matches).encode())
    mocker.patch("subprocess.run", return_value=mock_proc)

    rule_yaml = "id: test\nlanguage: python\nrule:\n  pattern: print($$$A)\n"
    result = tools["ast_test_rule"](code="print('x')", rule_yaml=rule_yaml)
    assert "match" in result.lower() or "<stdin>" in result


def test_ast_test_rule_no_match(tools, mocker):
    """ast_test_rule returns helpful hint when rule doesn't match."""
    mock_proc = _make_process(stdout=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    rule_yaml = "id: test\nlanguage: python\nrule:\n  pattern: doesnt_match()\n"
    result = tools["ast_test_rule"](code="print('x')", rule_yaml=rule_yaml)
    assert "No matches found" in result
    assert "Hint" in result
