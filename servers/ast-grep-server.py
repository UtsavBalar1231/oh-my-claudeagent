#!/usr/bin/env python3
"""
ast-grep MCP Server — Structural code search and transformation.
Uses FastMCP with 5 tools: search, replace, find-by-rule, dump-tree, test-match.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
from typing import Literal

import yaml
from mcp.server.fastmcp import FastMCP
from pydantic import Field

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_LANGUAGES = [
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

# ---------------------------------------------------------------------------
# Binary discovery
# ---------------------------------------------------------------------------

SG_BIN: str = ""


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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def run_command(
    cmd: list[str],
    *,
    input_data: bytes | None = None,
    allow_exit_1: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    """Run a subprocess with timeout. Raises ToolError on failure."""
    try:
        result = subprocess.run(
            cmd,
            input=input_data,
            capture_output=True,
            timeout=TIMEOUT,
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
        lines.append("Use dryRun=false to apply changes")

    return "\n".join(lines)


def format_scan_results(matches: list[dict], max_results: int) -> str:
    """Format output from `ast-grep scan --json=compact` (Tools 3 & 5)."""
    total = len(matches)
    truncated = total > max_results
    if truncated:
        matches = matches[:max_results]

    if not matches:
        return ""

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


def validate_language(lang: str) -> None:
    """Raise ToolError if language is unsupported."""
    if lang not in SUPPORTED_LANGUAGES:
        raise ToolError(
            f"Unsupported language '{lang}'. Supported: {', '.join(SUPPORTED_LANGUAGES)}"
        )


# ---------------------------------------------------------------------------
# ToolError — FastMCP catches this and returns it as a tool error response
# ---------------------------------------------------------------------------


class ToolError(Exception):
    pass


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

mcp = FastMCP("ast-grep")


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def ast_grep_search(
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
    """Search code patterns across the filesystem using AST-aware structural matching. Supports 25 languages."""
    validate_language(lang)

    cmd = [SG_BIN, "run", "-p", pattern, "--lang", lang, "--json=compact"]
    if context and context > 0:
        cmd.extend(["-C", str(context)])
    if globs:
        for g in globs:
            cmd.extend(["--globs", g])
    cmd.extend(paths if paths else ["."])

    result = run_command(cmd, allow_exit_1=True)
    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    if not stdout:
        return "No matches found"

    matches = json.loads(stdout)

    if output_format == "json":
        return json.dumps(matches[:max_results], indent=2)

    return format_run_results(matches, max_results)


@mcp.tool(
    annotations={"destructiveHint": True},
)
def ast_grep_replace(
    pattern: str = Field(description="AST pattern to match"),
    rewrite: str = Field(
        description="Replacement pattern (can use $VAR from the match pattern)"
    ),
    lang: SupportedLang = Field(description="Target language"),
    paths: list[str] | None = Field(default=None, description="Paths to search"),
    globs: list[str] | None = Field(default=None, description="Include/exclude globs"),
    dryRun: bool = Field(
        default=True, description="Preview changes without applying (default: true)"
    ),
) -> str:
    """Replace code patterns across the filesystem with AST-aware rewriting. Dry-run by default."""
    validate_language(lang)

    cmd = [
        SG_BIN,
        "run",
        "-p",
        pattern,
        "-r",
        rewrite,
        "--lang",
        lang,
        "--json=compact",
    ]
    if not dryRun:
        cmd.append("--update-all")
    if globs:
        for g in globs:
            cmd.extend(["--globs", g])
    cmd.extend(paths if paths else ["."])

    result = run_command(cmd, allow_exit_1=True)
    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    if not stdout:
        return "No matches found to replace"

    matches = json.loads(stdout)
    return format_run_results(
        matches, MAX_RESULTS_DEFAULT, is_replace=True, is_dry_run=dryRun
    )


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def find_code_by_rule(
    yaml: str = Field(
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
    """Search code using a YAML rule with advanced combinators (kind, has, inside, follows, precedes, all, any, not). More powerful than pattern-only search."""
    validate_yaml_rule(yaml)

    cmd = [SG_BIN, "scan", "--inline-rules", yaml, "--json=compact"]
    cmd.extend(paths if paths else ["."])

    result = run_command(cmd)
    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    if not stdout:
        return "No matches found"

    matches = json.loads(stdout)
    if not matches:
        return "No matches found"

    if output_format == "json":
        return json.dumps(matches[:max_results], indent=2)

    return format_scan_results(matches, max_results)


@mcp.tool(
    annotations={"readOnlyHint": True, "idempotentHint": True},
)
def dump_syntax_tree(
    code: str = Field(description="Code snippet to visualize"),
    language: SupportedLang = Field(description="Language of the code"),
    format: Literal["cst", "ast", "pattern"] = Field(
        default="cst",
        description="Tree format: cst (full concrete syntax tree), ast (omit unnamed nodes), pattern (how ast-grep interprets a pattern)",
    ),
) -> str:
    """Dump the syntax tree of a code snippet. Use 'cst' to inspect target code, 'pattern' to debug why a pattern doesn't match, 'ast' for a simplified view."""
    validate_language(language)

    # --debug-query outputs the tree to stderr, not stdout.
    cmd = [
        SG_BIN,
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
def test_match_code_rule(
    code: str = Field(description="Code snippet to test against"),
    yaml: str = Field(
        description=(
            "YAML rule to test. Must include id, language, and rule fields. Example:\n"
            "  id: test\n"
            "  language: python\n"
            "  rule:\n"
            "    pattern: print($$$A)"
        )
    ),
) -> str:
    """Test whether a YAML rule matches a code snippet. Use this to validate rules before running them across the codebase."""
    validate_yaml_rule(yaml)

    cmd = [SG_BIN, "scan", "--inline-rules", yaml, "--stdin", "--json=compact"]

    result = run_command(cmd, input_data=code.encode())
    stdout = result.stdout.decode("utf-8", errors="replace").strip()

    no_match_msg = (
        "No matches found.\n\n"
        "Hint: If using relational rules (has, inside, follows, precedes), "
        "try adding `stopBy: end` to search the entire subtree."
    )

    if not stdout:
        return no_match_msg

    matches = json.loads(stdout)
    if not matches:
        return no_match_msg

    return format_scan_results(matches, MAX_RESULTS_DEFAULT)


# ---------------------------------------------------------------------------
# Signal handling & entry point
# ---------------------------------------------------------------------------

signal.signal(signal.SIGINT, signal.SIG_IGN)


def _graceful_exit(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, _graceful_exit)

if __name__ == "__main__":
    SG_BIN = discover_binary()
    print(f"ast-grep MCP server starting (binary: {SG_BIN})", file=sys.stderr)
    mcp.run()
