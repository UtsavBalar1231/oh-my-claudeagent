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


def test_ast_search_inserts_path_separator_and_defaults_paths(tools, mocker):
    """ast_search inserts -- before default path args."""
    mock_proc = _make_process(stdout=b"[]")
    run_mock = mocker.patch("subprocess.run", return_value=mock_proc)

    tools["ast_search"](
        pattern="print($$$A)",
        lang="python",
        paths=None,
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )

    cmd = run_mock.call_args.args[0]
    assert cmd[-2:] == ["--", "."]


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
    assert "Hints" not in result


def test_ast_search_no_match_hints_regex_patterns(tools, mocker):
    """ast_search adds guidance only for likely regex-shaped AST patterns."""
    mock_proc = _make_process(stdout=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_search"](
        pattern=r"foo|bar",
        lang="python",
        paths=["."],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )
    assert "No matches found" in result
    assert "Hints" in result
    assert "alternation" in result


def test_ast_search_no_match_hints_c_bare_call(tools, mocker):
    """ast_search warns that bare C call patterns parse as macro_type_specifier."""
    mock_proc = _make_process(stdout=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_search"](
        pattern="lapis_record_set_outcome($$$)",
        lang="c",
        paths=["."],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )
    assert "No matches found" in result
    assert "Hints" in result
    assert "call_expression" in result


def test_ast_search_surfaces_error_node_warning(tools, mocker):
    """A swallowed ast-grep 'ERROR node' warning is surfaced on zero-match."""
    stderr = (
        b"Warning: Pattern contains an ERROR node and may cause unexpected results.\n"
        b"Help: ast-grep parsed the pattern but it matched nothing in this run.\n"
        b"See also: https://ast-grep.github.io/playground.html\n"
    )
    mock_proc = _make_process(returncode=0, stdout=b"", stderr=stderr)
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_search"](
        pattern="target($$$)",
        lang="solidity",
        paths=["."],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )
    assert "No matches found" in result
    assert "ERROR node" in result
    assert "kind:" in result
    assert "See also" not in result  # Help/URL noise stripped


def test_ast_search_extension_mismatch_hint(tools, mocker, tmp_path):
    """An explicit file whose extension cannot match the requested lang is flagged."""
    f = tmp_path / "x.c"
    f.write_text("int main(){ return 0; }\n")
    mocker.patch("tools.ast.resolve_workspace", return_value=str(tmp_path))
    mock_proc = _make_process(returncode=1, stdout=b"", stderr=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_search"](
        pattern="return $X",
        lang="cpp",
        paths=["x.c"],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )
    assert "No matches found" in result
    assert "extension" in result
    assert "lang='cpp'" in result


def test_ast_search_hard_parse_error_raises(tools, mocker):
    """A hard parse error (exit 8) raises ToolError, never a silent zero."""
    stderr = b"Error: Cannot parse query as a valid pattern.\nHelp: fix the pattern.\n"
    mock_proc = _make_process(returncode=8, stdout=b"", stderr=stderr)
    mocker.patch("subprocess.run", return_value=mock_proc)

    with pytest.raises(ToolError, match="ast-grep error"):
        tools["ast_search"](
            pattern="greet() { $$$ }",
            lang="bash",
            paths=["."],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )


def test_ast_search_wellformed_zero_stays_clean(tools, mocker):
    """A well-formed, genuinely-absent pattern stays a plain 'No matches found'."""
    mock_proc = _make_process(returncode=1, stdout=b"", stderr=b"")
    mocker.patch("subprocess.run", return_value=mock_proc)

    result = tools["ast_search"](
        pattern="missing($$$)",
        lang="python",
        paths=["."],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )
    assert result == "No matches found"


def test_pattern_warning_strips_noise():
    """pattern_warning returns only the Warning line, dropping Help/See-also."""
    stderr = (
        b"Warning: Pattern contains an ERROR node and may cause unexpected results.\n"
        b"Help: x\nSee also: https://example\n"
    )
    out = ast_module.pattern_warning(stderr)
    assert (
        out
        == "Warning: Pattern contains an ERROR node and may cause unexpected results."
    )
    assert ast_module.pattern_warning(b"") is None
    assert ast_module.pattern_warning(b"ERROR: file: No such file\n") is None


def test_extension_mismatch_skips_directories(tmp_path, mocker):
    """extension_mismatch returns None when a path is a directory or matches the lang."""
    mocker.patch("tools.ast.resolve_workspace", return_value=str(tmp_path))
    (tmp_path / "x.c").write_text("int x;\n")
    assert ast_module.extension_mismatch(["."], "cpp") is None  # directory
    assert ast_module.extension_mismatch(["x.c"], "c") is None  # extension matches lang
    assert ast_module.extension_mismatch(["x.c"], "cpp") is not None  # genuine mismatch


def test_ast_search_rejects_unsafe_paths(tools):
    """ast_search validates path args before invoking ast-grep."""
    with pytest.raises(ToolError, match="empty"):
        tools["ast_search"](
            pattern="$X",
            lang="python",
            paths=[""],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )

    with pytest.raises(ToolError, match="null bytes"):
        tools["ast_search"](
            pattern="$X",
            lang="python",
            paths=["bad\x00path"],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )

    with pytest.raises(ToolError, match="start with '-'"):
        tools["ast_search"](
            pattern="$X",
            lang="python",
            paths=["-danger"],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )

    with pytest.raises(ToolError, match="escapes workspace"):
        tools["ast_search"](
            pattern="$X",
            lang="python",
            paths=["../outside"],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )


def test_ast_search_normalizes_absolute_workspace_paths(tools, mocker, tmp_path):
    """Absolute paths inside the workspace are normalized to relative args."""
    workspace = tmp_path / "workspace"
    child = workspace / "src"
    child.mkdir(parents=True)
    mocker.patch("os.getcwd", return_value=str(workspace))
    mock_proc = _make_process(stdout=b"[]")
    run_mock = mocker.patch("subprocess.run", return_value=mock_proc)

    tools["ast_search"](
        pattern="$X",
        lang="python",
        paths=[str(child)],
        globs=None,
        context=None,
        max_results=500,
        output_format="text",
    )

    assert run_mock.call_args.args[0][-2:] == ["--", "src"]


def test_ast_search_rejects_symlink_escape(tools, mocker, tmp_path):
    """Existing symlinks must not resolve outside the workspace."""
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    (workspace / "escape").symlink_to(outside, target_is_directory=True)
    mocker.patch("os.getcwd", return_value=str(workspace))

    with pytest.raises(ToolError, match="outside workspace"):
        tools["ast_search"](
            pattern="$X",
            lang="python",
            paths=["escape"],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )


def test_ast_search_truncated_json_recovers_complete_objects(tools, mocker):
    """Oversized JSON output is capped and parsed through complete objects."""
    first = {
        "file": "one.py",
        "lines": "print('one')",
        "range": {"start": {"line": 0, "column": 0}},
    }
    second = {
        "file": "two.py",
        "lines": "print('two')",
        "range": {"start": {"line": 1, "column": 0}},
    }
    payload = ("[" + json.dumps(first) + "," + json.dumps(second) + "]").encode()
    cap = len(json.dumps(first).encode()) + 3
    mocker.patch.object(ast_module, "MAX_JSON_OUTPUT_BYTES", cap)
    mock_proc = _make_process(stdout=payload)
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

    assert "[TRUNCATED]" in result
    assert "one.py" in result


def test_ast_search_json_parse_errors_are_tool_errors(tools, mocker):
    """Malformed JSON is reported without raw JSONDecodeError tracebacks."""
    mock_proc = _make_process(stdout=b"not json")
    mocker.patch("subprocess.run", return_value=mock_proc)

    with pytest.raises(ToolError, match="Failed to parse ast-grep JSON output"):
        tools["ast_search"](
            pattern="$X",
            lang="python",
            paths=["."],
            globs=None,
            context=None,
            max_results=500,
            output_format="text",
        )


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
    assert "Hints" not in result


def test_ast_replace_apply_uses_two_pass_commands(tools, mocker):
    """ast_replace dry_run=False previews JSON, then applies with --update-all."""
    matches = [
        {
            "file": "app.py",
            "lines": "old_func(x)",
            "range": {"start": {"line": 0, "column": 0}},
        }
    ]
    preview_proc = _make_process(stdout=json.dumps(matches).encode())
    apply_proc = _make_process(stdout=b"")
    run_mock = mocker.patch("subprocess.run", side_effect=[preview_proc, apply_proc])

    result = tools["ast_replace"](
        pattern="old_func($X)",
        rewrite="new_func($X)",
        lang="python",
        paths=["."],
        globs=None,
        dry_run=False,
    )

    assert "replacement" in result
    preview_cmd = run_mock.call_args_list[0].args[0]
    apply_cmd = run_mock.call_args_list[1].args[0]
    assert "--json=compact" in preview_cmd
    assert "--update-all" not in preview_cmd
    assert "--json=compact" not in apply_cmd
    assert "--update-all" in apply_cmd
    assert apply_cmd[-2:] == ["--", "."]


def test_ast_replace_apply_refused_when_truncated(tools, mocker):
    """Apply is refused (no second subprocess) when matches exceed the preview cap."""
    matches = [
        {
            "file": f"f{i}.py",
            "lines": "old_func(x)",
            "range": {"start": {"line": 0, "column": 0}},
        }
        for i in range(ast_module.MAX_RESULT_CAP + 1)
    ]
    preview_proc = _make_process(stdout=json.dumps(matches).encode())
    run_mock = mocker.patch("subprocess.run", return_value=preview_proc)

    with pytest.raises(ToolError, match="Refusing to apply"):
        tools["ast_replace"](
            pattern="old_func($X)",
            rewrite="new_func($X)",
            lang="python",
            paths=["."],
            globs=None,
            dry_run=False,
        )
    # Only the preview ran; --update-all was never spawned.
    assert run_mock.call_count == 1


def test_ast_replace_apply_failure_reports_replace_failed(tools, mocker):
    """Second-pass failures include Replace failed context."""
    matches = [
        {
            "file": "app.py",
            "lines": "old_func(x)",
            "range": {"start": {"line": 0, "column": 0}},
        }
    ]
    preview_proc = _make_process(stdout=json.dumps(matches).encode())
    apply_proc = _make_process(returncode=2, stderr=b"write failed")
    mocker.patch("subprocess.run", side_effect=[preview_proc, apply_proc])

    with pytest.raises(ToolError, match="Replace failed"):
        tools["ast_replace"](
            pattern="old_func($X)",
            rewrite="new_func($X)",
            lang="python",
            paths=["."],
            globs=None,
            dry_run=False,
        )


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


def test_ast_find_rule_inserts_path_separator(tools, mocker):
    """ast_find_rule inserts -- before path args."""
    mock_proc = _make_process(stdout=b"[]")
    run_mock = mocker.patch("subprocess.run", return_value=mock_proc)

    rule_yaml = "id: noop\nlanguage: python\nrule:\n  pattern: doesnt_exist()\n"
    tools["ast_find_rule"](
        rule_yaml=rule_yaml,
        paths=["."],
        max_results=500,
        output_format="text",
    )

    assert run_mock.call_args.args[0][-2:] == ["--", "."]


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
