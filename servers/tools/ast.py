"""AST structural code search tools (ast-grep)."""

import json
import os
import re
import shutil
import subprocess
import sys
from typing import Literal, get_args

import yaml
from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import ToolError

# --- AST Constants ---

SupportedLang = Literal[
    "bash",
    "c",
    "cpp",
    "csharp",
    "css",
    "elixir",
    "go",
    "haskell",
    "html",
    "java",
    "javascript",
    "json",
    "kotlin",
    "lua",
    "nix",
    "php",
    "python",
    "ruby",
    "rust",
    "scala",
    "solidity",
    "swift",
    "typescript",
    "tsx",
    "yaml",
]

SUPPORTED_LANGUAGES: list[str] = list(get_args(SupportedLang))

LANG_EXTENSIONS = {
    ".bash": "bash",
    ".sh": "bash",
    ".zsh": "bash",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".css": "css",
    ".ex": "elixir",
    ".exs": "elixir",
    ".go": "go",
    ".hs": "haskell",
    ".html": "html",
    ".htm": "html",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".kt": "kotlin",
    ".lua": "lua",
    ".nix": "nix",
    ".php": "php",
    ".py": "python",
    ".pyi": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".scala": "scala",
    ".sol": "solidity",
    ".swift": "swift",
    ".ts": "typescript",
    ".cts": "typescript",
    ".mts": "typescript",
    ".tsx": "tsx",
    ".yml": "yaml",
    ".yaml": "yaml",
}

TIMEOUT = 300
MAX_RESULTS_DEFAULT = 500
MAX_JSON_OUTPUT_BYTES = 1024 * 1024
MAX_RESULT_CAP = 500


def discover_binary() -> str:
    """Find the ast-grep CLI binary. Tries $AST_GREP_BIN, ast-grep, sg."""
    env_bin = os.environ.get("AST_GREP_BIN")
    if env_bin:
        if shutil.which(env_bin):
            return env_bin
        print(f"WARNING: $AST_GREP_BIN={env_bin} not found in PATH", file=sys.stderr)

    for name in ("ast-grep", "sg"):
        path = shutil.which(name)
        if path:
            # Verify it's actually ast-grep (not Linux sg/setgroup)
            try:
                result = subprocess.run(
                    [path, "--version"],
                    capture_output=True,
                    timeout=5,
                    text=True,
                )
                if "ast-grep" in result.stdout.lower():
                    return path
            except (subprocess.TimeoutExpired, OSError):
                continue

    print(
        "ERROR: ast-grep CLI not found.\n\n"
        "Install options:\n"
        "  cargo install ast-grep --locked\n"
        "  brew install ast-grep\n"
        "  npm install -g @ast-grep/cli\n"
        "  pacman -S ast-grep\n",
        file=sys.stderr,
    )
    sys.exit(1)


# Module-level binary reference — set by set_sg_bin() in the entry point after discover_binary() resolves a path.
_SG_BIN: str | None = None


def get_sg_bin() -> str | None:
    """Return the currently configured ast-grep binary path."""
    return _SG_BIN


def set_sg_bin(path: str) -> None:
    """Set the ast-grep binary path (called from entry point after discovery)."""
    global _SG_BIN
    _SG_BIN = path


def run_command(
    cmd: list[str],
    *,
    input_data: bytes | None = None,
    allow_exit_1: bool = False,
    cwd: str | None = None,
) -> subprocess.CompletedProcess[bytes]:
    """Run a subprocess with timeout. Raises ToolError on failure."""
    if _SG_BIN is None:
        raise ToolError("ast-grep binary not initialized")
    try:
        result = subprocess.run(
            cmd,
            input=input_data,
            capture_output=True,
            timeout=TIMEOUT,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired:
        raise ToolError(f"Command timed out after {TIMEOUT}s") from None
    except FileNotFoundError:
        raise ToolError(f"Binary not found: {cmd[0]}") from None

    # ast-grep run returns exit 1 on no-match (normal), 0 on match.
    # ast-grep scan returns 0 in both cases.
    if result.returncode != 0:
        if allow_exit_1 and result.returncode == 1:
            return result
        stderr_text = result.stderr.decode("utf-8", errors="replace").strip()
        if stderr_text and "No files found" not in stderr_text:
            raise ToolError(f"ast-grep error (exit {result.returncode}): {stderr_text}")

    return result


def resolve_workspace() -> str:
    """Resolve the workspace root used to constrain path arguments."""
    for env_name in ("CLAUDE_PROJECT_DIR", "CLAUDE_PROJECT_ROOT", "HOOK_PROJECT_ROOT"):
        value = os.environ.get(env_name)
        if value:
            return os.path.realpath(value)
    return os.path.realpath(os.getcwd())


def normalize_workspace_paths(paths: list[str] | None) -> list[str]:
    """Validate path arguments and normalize allowed paths to workspace-relative paths."""
    workspace = resolve_workspace()
    normalized: list[str] = []

    for path in paths or ["."]:
        if path == "":
            raise ToolError("Path entries must not be empty")
        if "\x00" in path:
            raise ToolError("Path entries must not contain null bytes")
        if path.startswith("-"):
            raise ToolError("Path entries must not start with '-'")

        absolute_path = path if os.path.isabs(path) else os.path.join(workspace, path)
        absolute_path = os.path.abspath(absolute_path)
        if os.path.commonpath([workspace, absolute_path]) != workspace:
            raise ToolError(f"Path escapes workspace: {path}")

        if os.path.exists(absolute_path):
            real_path = os.path.realpath(absolute_path)
            if os.path.commonpath([workspace, real_path]) != workspace:
                raise ToolError(f"Path resolves outside workspace: {path}")

        relative_path = os.path.relpath(absolute_path, workspace)
        normalized.append("." if relative_path == "." else relative_path)

    return normalized


def clamp_max_results(max_results: int) -> int:
    """Apply the hard result cap for AST output."""
    return max(0, min(max_results, MAX_RESULT_CAP))


def parse_compact_json_output(stdout: bytes) -> tuple[list[dict], bool]:
    """Parse ast-grep compact JSON with output and result caps."""
    if not stdout.strip():
        return [], False

    output_truncated = len(stdout) > MAX_JSON_OUTPUT_BYTES
    raw = stdout[:MAX_JSON_OUTPUT_BYTES]
    text = raw.decode("utf-8", errors="replace").strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        if not output_truncated:
            raise ToolError(
                f"Failed to parse ast-grep JSON output: {error.msg}"
            ) from None
        parsed = parse_truncated_json_array(text)
        if parsed is None:
            raise ToolError(
                "ast-grep JSON output exceeded 1 MiB and could not be parsed through a complete result"
            ) from None

    if not isinstance(parsed, list):
        raise ToolError("Failed to parse ast-grep JSON output: expected a JSON array")

    return parsed[:MAX_RESULT_CAP], output_truncated or len(parsed) > MAX_RESULT_CAP


def parse_truncated_json_array(text: str) -> list[dict] | None:
    """Recover complete leading objects from a truncated JSON array."""
    decoder = json.JSONDecoder()
    index = 0
    length = len(text)
    while index < length and text[index].isspace():
        index += 1
    if index >= length or text[index] != "[":
        return None
    index += 1
    items: list[dict] = []

    while len(items) < MAX_RESULT_CAP:
        while index < length and text[index].isspace():
            index += 1
        if index < length and text[index] == ",":
            index += 1
            continue
        if index < length and text[index] == "]":
            return items
        try:
            item, next_index = decoder.raw_decode(text, index)
        except json.JSONDecodeError:
            break
        if isinstance(item, dict):
            items.append(item)
        index = next_index

    return items if items else None


def no_match_message(pattern: str, lang: str, *, is_replace: bool = False) -> str:
    """Return no-match text with common ast-grep pattern hints."""
    base = "No matches found to replace" if is_replace else "No matches found"
    stripped = pattern.strip()
    hints: list[str] = []

    if re.search(r"\\[wWdDsSbB]", stripped):
        hints.append(
            "Regex escapes like \\w, \\d, \\s, and \\b do not work in ast-grep patterns. Use $VAR for one AST node or switch to grep for text search."
        )
    if re.search(r"\[[A-Za-z0-9]-[A-Za-z0-9]\]", stripped):
        hints.append(
            "Character ranges like [a-z] are regex syntax, not AST syntax. Use $VAR for identifiers or switch to grep."
        )
    if "$" not in stripped and re.search(r"\.[*+]", stripped):
        hints.append(
            "Regex wildcards like .* and .+ do not work in ast-grep. Use $$$ for multiple AST nodes or switch to grep."
        )
    if re.fullmatch(r"[-\w.*]+\|[-\w.*|]+", stripped):
        hints.append(
            "Regex alternation with | does not work in ast-grep patterns. Run separate AST searches or switch to grep."
        )

    if (
        lang == "python"
        and stripped.startswith(("def ", "class ", "async def "))
        and stripped.endswith(":")
    ):
        hints.append(f"Remove the trailing colon. Try `{stripped[:-1]}`.")
    if (
        lang in {"javascript", "typescript", "tsx"}
        and "function" in pattern
        and "{" not in pattern
    ):
        hints.append(
            "JS/TS/TSX function patterns should be complete AST nodes, e.g. `function $NAME($$$ARGS) { $$$BODY }`."
        )
    if lang == "go" and pattern.lstrip().startswith("func") and "{" not in pattern:
        hints.append(
            "Go function patterns should include a body, e.g. `func $NAME($$$ARGS) { $$$BODY }`."
        )
    if lang == "rust" and pattern.lstrip().startswith("fn ") and "{" not in pattern:
        hints.append(
            "Rust function patterns should include a body, e.g. `fn $NAME($$$ARGS) { $$$BODY }`."
        )
    return base if not hints else base + "\n\nHints:\n- " + "\n- ".join(hints)


def format_run_results(
    matches: list[dict],
    max_results: int,
    is_replace: bool = False,
    is_dry_run: bool = False,
) -> str:
    """Format output from `ast-grep run --json=compact` (Tools 1 & 2)."""
    total = len(matches)
    truncated = total > max_results
    if truncated:
        matches = matches[:max_results]

    if not matches:
        return "No matches found" if not is_replace else "No matches found to replace"

    lines: list[str] = []
    if truncated:
        lines.append(f"[TRUNCATED] Showing first {max_results} of {total} matches\n")

    prefix = "[DRY RUN] " if is_dry_run else ""
    if is_replace:
        lines.append(f"{prefix}{len(matches)} replacement(s):\n")
    else:
        lines.append(f"Found {len(matches)} match(es):\n")

    for m in matches:
        file_path = m.get("file", "")
        rng = m.get("range", {})
        start = rng.get("start", {})
        line_num = start.get("line", 0) + 1
        col_num = start.get("column", 0) + 1
        lines.append(f"{file_path}:{line_num}:{col_num}")
        text = m.get("lines", m.get("text", "")).strip()
        if text:
            lines.append(f"  {text}")
        lines.append("")

    if is_replace and is_dry_run:
        lines.append("Use dry_run=false to apply changes")

    return "\n".join(lines)


def format_scan_results(matches: list[dict], max_results: int) -> str:
    """Format output from `ast-grep scan --json=compact` (Tools 3 & 5)."""
    total = len(matches)
    truncated = total > max_results
    if truncated:
        matches = matches[:max_results]

    if not matches:
        return "No matches found"

    lines: list[str] = []
    if truncated:
        lines.append(f"[TRUNCATED] Showing first {max_results} of {total} matches\n")

    lines.append(f"Found {len(matches)} match(es):\n")

    for m in matches:
        file_path = m.get("file", "<stdin>")
        rng = m.get("range", {})
        start = rng.get("start", {})
        line_num = start.get("line", 0) + 1
        col_num = start.get("column", 0) + 1
        rule_id = m.get("ruleId", "")
        severity = m.get("severity", "")
        header = f"{file_path}:{line_num}:{col_num}"
        if rule_id:
            header += f" [{rule_id}]"
        if severity:
            header += f" ({severity})"
        lines.append(header)
        text = m.get("lines", m.get("text", "")).strip()
        if text:
            lines.append(f"  {text}")
        lines.append("")

    return "\n".join(lines)


def validate_yaml_rule(yaml_str: str) -> dict:
    """Parse and validate a YAML rule string. Raises ToolError on failure."""
    try:
        parsed = yaml.safe_load(yaml_str)
    except yaml.YAMLError as e:
        raise ToolError(f"Invalid YAML: {e}") from e
    if not isinstance(parsed, dict):
        raise ToolError(
            "YAML rule must be a mapping with id, language, and rule fields"
        )
    return parsed


def register(mcp: FastMCP) -> None:
    """Register all AST tools on the given FastMCP instance."""

    @mcp.tool(
        annotations={"readOnlyHint": True, "idempotentHint": True},
    )
    def ast_search(
        pattern: str = Field(
            description="AST pattern with meta-variables ($VAR for single node, $$$ for multiple). Must be a complete AST node."
        ),
        lang: SupportedLang = Field(description="Target language"),
        paths: list[str] | None = Field(
            default=None, description="Paths to search (default: ['.'])"
        ),
        globs: list[str] | None = Field(
            default=None, description="Include/exclude globs (prefix ! to exclude)"
        ),
        context: int | None = Field(
            default=None, description="Context lines around each match"
        ),
        max_results: int = Field(
            default=MAX_RESULTS_DEFAULT, description="Maximum matches to return"
        ),
        output_format: Literal["text", "json"] = Field(
            default="text", description="Output format: text (compact) or json (full)"
        ),
    ) -> str:
        """Search code patterns across the filesystem using AST-aware structural matching. Use instead of grep when you need structural matches (function signatures, class shapes, import patterns) rather than text search. Supports 25 languages. Returns file:line:col with matched code snippets."""
        safe_paths = normalize_workspace_paths(paths)
        max_results = clamp_max_results(max_results)
        cmd = [_SG_BIN, "run", "-p", pattern, "--lang", lang, "--json=compact"]
        if context and context > 0:
            cmd.extend(["-C", str(context)])
        if globs:
            for g in globs:
                cmd.extend(["--globs", g])
        cmd.extend(["--", *safe_paths])

        result = run_command(cmd, allow_exit_1=True, cwd=resolve_workspace())
        if not result.stdout.strip():
            return no_match_message(pattern, lang)

        matches, truncated = parse_compact_json_output(result.stdout)
        if not matches:
            return no_match_message(pattern, lang)

        if output_format == "json":
            return json.dumps(matches[:max_results], indent=2)

        output = format_run_results(matches, max_results)
        if truncated and not output.startswith("[TRUNCATED]"):
            output = "[TRUNCATED] Output exceeded AST MCP caps\n\n" + output
        return output

    @mcp.tool(
        annotations={"destructiveHint": True},
    )
    def ast_replace(
        pattern: str = Field(description="AST pattern to match"),
        rewrite: str = Field(
            description="Replacement pattern (can use $VAR from the match pattern)"
        ),
        lang: SupportedLang = Field(description="Target language"),
        paths: list[str] | None = Field(default=None, description="Paths to search"),
        globs: list[str] | None = Field(
            default=None, description="Include/exclude globs"
        ),
        dry_run: bool = Field(
            default=True, description="Preview changes without applying (default: true)"
        ),
    ) -> str:
        """Replace code patterns across the filesystem with AST-aware rewriting. Use for safe structural refactoring — renaming variables, updating function signatures, or migrating API calls. Always use dry_run=true first to preview changes. Returns list of replacements with file:line locations."""
        safe_paths = normalize_workspace_paths(paths)
        preview_cmd = [
            _SG_BIN,
            "run",
            "-p",
            pattern,
            "-r",
            rewrite,
            "--lang",
            lang,
            "--json=compact",
        ]
        if globs:
            for g in globs:
                preview_cmd.extend(["--globs", g])
        preview_cmd.extend(["--", *safe_paths])

        workspace = resolve_workspace()
        result = run_command(preview_cmd, allow_exit_1=True, cwd=workspace)
        if not result.stdout.strip():
            return no_match_message(pattern, lang, is_replace=True)

        matches, truncated = parse_compact_json_output(result.stdout)
        if not matches:
            return no_match_message(pattern, lang, is_replace=True)

        if dry_run:
            output = format_run_results(
                matches, MAX_RESULT_CAP, is_replace=True, is_dry_run=True
            )
            if truncated and not output.startswith("[TRUNCATED]"):
                output = "[TRUNCATED] Output exceeded AST MCP caps\n\n" + output
            return output

        apply_cmd = [
            _SG_BIN,
            "run",
            "-p",
            pattern,
            "-r",
            rewrite,
            "--lang",
            lang,
            "--update-all",
        ]
        if globs:
            for g in globs:
                apply_cmd.extend(["--globs", g])
        apply_cmd.extend(["--", *safe_paths])

        try:
            run_command(apply_cmd, cwd=workspace)
        except ToolError as error:
            raise ToolError(f"Replace failed: {error}") from None

        output = format_run_results(
            matches, MAX_RESULT_CAP, is_replace=True, is_dry_run=False
        )
        if truncated and not output.startswith("[TRUNCATED]"):
            output = "[TRUNCATED] Output exceeded AST MCP caps\n\n" + output
        return output

    @mcp.tool(
        annotations={"readOnlyHint": True, "idempotentHint": True},
    )
    def ast_find_rule(
        rule_yaml: str = Field(
            description=(
                "YAML rule with id, language, and rule fields. Example:\n"
                "  id: find-imports\n"
                "  language: python\n"
                "  rule:\n"
                "    pattern: import $MOD\n\n"
                "For relational rules (has, inside, follows, precedes), add `stopBy: end` "
                "to search the entire subtree, not just direct children."
            )
        ),
        paths: list[str] | None = Field(
            default=None, description="Paths to search (default: ['.'])"
        ),
        max_results: int = Field(
            default=MAX_RESULTS_DEFAULT, description="Maximum matches to return"
        ),
        output_format: Literal["text", "json"] = Field(
            default="text", description="Output format: text (compact) or json (full)"
        ),
    ) -> str:
        """Search code using a YAML rule with advanced combinators (kind, has, inside, follows, precedes, all, any, not). Use when ast_search patterns are insufficient — for context-sensitive matches like "function calls inside a class" or "imports followed by usage". Returns file:line:col with matched code and rule ID."""
        validate_yaml_rule(rule_yaml)

        safe_paths = normalize_workspace_paths(paths)
        max_results = clamp_max_results(max_results)
        cmd = [_SG_BIN, "scan", "--inline-rules", rule_yaml, "--json=compact"]
        cmd.extend(["--", *safe_paths])

        result = run_command(cmd, cwd=resolve_workspace())
        if not result.stdout.strip():
            return "No matches found"

        matches, truncated = parse_compact_json_output(result.stdout)
        if not matches:
            return "No matches found"

        if output_format == "json":
            return json.dumps(matches[:max_results], indent=2)

        output = format_scan_results(matches, max_results)
        if truncated and not output.startswith("[TRUNCATED]"):
            output = "[TRUNCATED] Output exceeded AST MCP caps\n\n" + output
        return output

    @mcp.tool(
        annotations={"readOnlyHint": True, "idempotentHint": True},
    )
    def ast_dump_tree(
        code: str = Field(description="Code snippet to visualize"),
        language: SupportedLang = Field(description="Language of the code"),
        format: Literal["cst", "ast", "pattern"] = Field(
            default="cst",
            description="Tree format: cst (full concrete syntax tree), ast (omit unnamed nodes), pattern (how ast-grep interprets a pattern)",
        ),
    ) -> str:
        """Dump the syntax tree of a code snippet. Use when building or debugging AST patterns — 'cst' shows full concrete syntax (use on target code), 'pattern' shows how ast-grep interprets a pattern (use when pattern doesn't match), 'ast' gives a simplified view. Returns tree output to stderr (captured here as the return value)."""
        # --debug-query outputs the tree to stderr, not stdout.
        cmd = [
            _SG_BIN,
            "run",
            "--pattern",
            code,
            "--lang",
            language,
            f"--debug-query={format}",
            "--stdin",
        ]

        result = run_command(cmd, input_data=code.encode(), allow_exit_1=True)
        tree_output = result.stderr.decode("utf-8", errors="replace").strip()

        if not tree_output:
            return "No syntax tree output. The code may be empty or unparseable."

        return tree_output

    @mcp.tool(
        annotations={"readOnlyHint": True, "idempotentHint": True},
    )
    def ast_test_rule(
        code: str = Field(description="Code snippet to test against"),
        rule_yaml: str = Field(
            description=(
                "YAML rule to test. Must include id, language, and rule fields. Example:\n"
                "  id: test\n"
                "  language: python\n"
                "  rule:\n"
                "    pattern: print($$$A)"
            )
        ),
    ) -> str:
        """Test whether a YAML rule matches a code snippet. Use before running ast_find_rule across the codebase to validate rule correctness on a small example. Returns matched locations and snippets, or a no-match message with debugging hints."""
        validate_yaml_rule(rule_yaml)

        cmd = [
            _SG_BIN,
            "scan",
            "--inline-rules",
            rule_yaml,
            "--stdin",
            "--json=compact",
        ]

        result = run_command(cmd, input_data=code.encode())
        no_match_msg = (
            "No matches found.\n\n"
            "Hint: If using relational rules (has, inside, follows, precedes), "
            "try adding `stopBy: end` to search the entire subtree."
        )

        if not result.stdout.strip():
            return no_match_msg

        matches, truncated = parse_compact_json_output(result.stdout)
        if not matches:
            return no_match_msg

        output = format_scan_results(matches, MAX_RESULT_CAP)
        if truncated and not output.startswith("[TRUNCATED]"):
            output = "[TRUNCATED] Output exceeded AST MCP caps\n\n" + output
        return output
