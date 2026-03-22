#!/usr/bin/env python3
"""
omca-mcp — Unified MCP server for oh-my-claudeagent.
Provides structural code search (ast-grep), work plan tracking (boulder),
verification evidence, and subagent learning notepads.
"""

import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Literal, get_args

import yaml
from mcp.server.fastmcp import FastMCP
from pydantic import Field

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

# --- AST Binary ---

SG_BIN: str | None = None

# --- State Constants ---

OMCA_STATE_DIR = ".omca/state"
BOULDER_FILE = "boulder.json"
EVIDENCE_FILE = "verification-evidence.json"
RALPH_STATE_FILE = "ralph-state.json"
ULTRAWORK_STATE_FILE = "ultrawork-state.json"
NOTEPADS_DIR = "notepads"
VALID_SECTIONS = ("learnings", "issues", "decisions", "problems", "questions")
AGENT_CATALOG_FILE = "agent-catalog.json"

# --- ToolError ---


class ToolError(Exception):
    pass


# --- AST Helpers ---


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


def run_command(
    cmd: list[str],
    *,
    input_data: bytes | None = None,
    allow_exit_1: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    """Run a subprocess with timeout. Raises ToolError on failure."""
    if SG_BIN is None:
        raise ToolError("ast-grep binary not initialized")
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


# --- State Helpers ---


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


# --- Server ---

mcp = FastMCP("omca")


# === AST TOOLS (5) ===


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
    """Search code patterns across the filesystem using AST-aware structural matching. Supports 25 languages."""
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
def ast_replace(
    pattern: str = Field(description="AST pattern to match"),
    rewrite: str = Field(
        description="Replacement pattern (can use $VAR from the match pattern)"
    ),
    lang: SupportedLang = Field(description="Target language"),
    paths: list[str] | None = Field(default=None, description="Paths to search"),
    globs: list[str] | None = Field(default=None, description="Include/exclude globs"),
    dry_run: bool = Field(
        default=True, description="Preview changes without applying (default: true)"
    ),
) -> str:
    """Replace code patterns across the filesystem with AST-aware rewriting. Dry-run by default."""
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
    if not dry_run:
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
        matches, MAX_RESULTS_DEFAULT, is_replace=True, is_dry_run=dry_run
    )


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
    """Search code using a YAML rule with advanced combinators (kind, has, inside, follows, precedes, all, any, not). More powerful than pattern-only search."""
    validate_yaml_rule(rule_yaml)

    cmd = [SG_BIN, "scan", "--inline-rules", rule_yaml, "--json=compact"]
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
def ast_dump_tree(
    code: str = Field(description="Code snippet to visualize"),
    language: SupportedLang = Field(description="Language of the code"),
    format: Literal["cst", "ast", "pattern"] = Field(
        default="cst",
        description="Tree format: cst (full concrete syntax tree), ast (omit unnamed nodes), pattern (how ast-grep interprets a pattern)",
    ),
) -> str:
    """Dump the syntax tree of a code snippet. Use 'cst' to inspect target code, 'pattern' to debug why a pattern doesn't match, 'ast' for a simplified view."""
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
    """Test whether a YAML rule matches a code snippet. Use this to validate rules before running them across the codebase."""
    validate_yaml_rule(rule_yaml)

    cmd = [SG_BIN, "scan", "--inline-rules", rule_yaml, "--stdin", "--json=compact"]

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


# === BOULDER TOOLS (2) ===


@mcp.tool()
def boulder_write(
    active_plan: str = Field(description="Absolute path to the plan file"),
    plan_name: str = Field(description="Short name for the plan"),
    session_id: str = Field(description="Current session ID"),
    agent: str = Field(default="atlas", description="Agent managing this plan"),
    worktree_path: str = Field(
        default="", description="Git worktree path if using worktrees"
    ),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Create or update boulder state. Appends session_id to existing sessions."""
    state = _state_dir(working_directory)
    path = os.path.join(state, BOULDER_FILE)
    existing = _read_json(path)

    session_ids = existing.get("session_ids", [])
    if session_id not in session_ids:
        session_ids.append(session_id)

    data = {
        "active_plan": active_plan,
        "started_at": existing.get(
            "started_at", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        ),
        "session_ids": session_ids,
        "plan_name": plan_name,
        "agent": agent,
    }
    if worktree_path:
        data["worktree_path"] = worktree_path

    _write_json(path, data)
    return f"Boulder state written: plan={plan_name}, sessions={len(session_ids)}"


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def boulder_progress(
    plan_path: str = Field(
        default="",
        description="Path to plan file (reads from boulder.json if empty)",
    ),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Parse plan file checkboxes and return progress summary."""
    if not plan_path:
        state = _state_dir(working_directory)
        boulder = _read_json(os.path.join(state, BOULDER_FILE))
        plan_path = boulder.get("active_plan", "")
        if not plan_path:
            return "No active plan found in boulder state."

    try:
        with open(plan_path) as f:
            content = f.read()
    except FileNotFoundError:
        raise ToolError(f"Plan file not found: {plan_path}") from None

    total = content.count("- [ ]") + content.count("- [x]")
    completed = content.count("- [x]")
    remaining = total - completed

    result = {
        "total": total,
        "completed": completed,
        "remaining": remaining,
        "is_complete": remaining == 0 and total > 0,
        "plan_path": plan_path,
    }
    return json.dumps(result, indent=2)


# === MODE TOOLS (2) ===


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def mode_read(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Read all active mode state: ralph, ultrawork, boulder, and evidence. Returns a unified dashboard."""
    state = _state_dir(working_directory)

    # Ralph
    ralph_data = _read_json(os.path.join(state, RALPH_STATE_FILE))
    ralph_section: dict = {"active": bool(ralph_data)}
    if ralph_data:
        ralph_section.update(ralph_data)

    # Ultrawork
    ultrawork_data = _read_json(os.path.join(state, ULTRAWORK_STATE_FILE))
    ultrawork_section: dict = {"active": bool(ultrawork_data)}
    if ultrawork_data:
        ultrawork_section.update(ultrawork_data)

    # Boulder
    boulder_data = _read_json(os.path.join(state, BOULDER_FILE))
    boulder_section: dict = {"active": bool(boulder_data)}
    if boulder_data:
        boulder_section.update(boulder_data)

    # Evidence
    evidence_data = _read_json(os.path.join(state, EVIDENCE_FILE))
    entries = evidence_data.get("entries", [])
    evidence_section: dict = {
        "active": bool(entries),
        "entry_count": len(entries),
    }
    if entries:
        evidence_section["latest"] = entries[-1]

    result = {
        "ralph": ralph_section,
        "ultrawork": ultrawork_section,
        "boulder": boulder_section,
        "evidence": evidence_section,
    }
    return json.dumps(result, indent=2)


@mcp.tool(annotations={"destructiveHint": True})
def mode_clear(
    mode: Literal["ralph", "ultrawork", "boulder", "evidence", "all"] = Field(
        default="all",
        description=(
            "Which state to clear: "
            "'ralph' (ralph-state.json), "
            "'ultrawork' (ultrawork-state.json), "
            "'boulder' (boulder.json), "
            "'evidence' (verification-evidence.json), "
            "'all' (ralph + ultrawork + boulder, NOT evidence)"
        ),
    ),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Clear active mode state files. 'all' clears ralph + ultrawork + boulder but NOT evidence."""
    state = _state_dir(working_directory)

    targets: list[tuple[str, str]] = []
    if mode == "ralph":
        targets = [("ralph", RALPH_STATE_FILE)]
    elif mode == "ultrawork":
        targets = [("ultrawork", ULTRAWORK_STATE_FILE)]
    elif mode == "boulder":
        targets = [("boulder", BOULDER_FILE)]
    elif mode == "evidence":
        targets = [("evidence", EVIDENCE_FILE)]
    else:  # all
        targets = [
            ("ralph", RALPH_STATE_FILE),
            ("ultrawork", ULTRAWORK_STATE_FILE),
            ("boulder", BOULDER_FILE),
        ]

    cleared: list[str] = []
    skipped: list[str] = []

    for label, filename in targets:
        path = os.path.join(state, filename)
        try:
            # Check if active before removing
            data = _read_json(path)
            was_active = bool(data)
            os.remove(path)
            status = "was active" if was_active else "was inactive"
            cleared.append(f"{label} ({status})")
        except FileNotFoundError:
            skipped.append(f"{label} (not found)")

    parts: list[str] = []
    if cleared:
        parts.append(f"Cleared: {', '.join(cleared)}.")
    if skipped:
        parts.append(f"Skipped: {', '.join(skipped)}.")

    return " ".join(parts) if parts else "Nothing to clear."


# === EVIDENCE TOOLS (2) ===


@mcp.tool()
def evidence_log(
    evidence_type: str = Field(
        description="Evidence type: build, test, lint, or manual. Called after verification commands."
    ),
    command: str = Field(description="Command that was executed"),
    exit_code: int = Field(description="Exit code of the command"),
    output_snippet: str = Field(
        description="Relevant output snippet (truncated if needed)"
    ),
    verified_by: str = Field(default="", description="Agent or user who verified"),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """REQUIRED after build/test/lint — task completion blocked without evidence. Append a timestamped verification evidence entry."""
    state = _state_dir(working_directory)
    path = os.path.join(state, EVIDENCE_FILE)
    data = _read_json(path)

    if "entries" not in data:
        data["entries"] = []

    entry = {
        "type": evidence_type,
        "command": command,
        "exit_code": exit_code,
        "output_snippet": output_snippet[:2000],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if verified_by:
        entry["verified_by"] = verified_by

    data["entries"].append(entry)
    _write_json(path, data)
    return f"Evidence recorded: {evidence_type} (exit {exit_code}), {len(data['entries'])} total entries"


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def evidence_read(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Read all verification evidence records."""
    state = _state_dir(working_directory)
    path = os.path.join(state, EVIDENCE_FILE)
    data = _read_json(path)
    if not data or not data.get("entries"):
        return "No verification evidence recorded."
    return json.dumps(data, indent=2)


# === NOTEPAD TOOLS (3) ===


@mcp.tool()
def notepad_write(
    plan_name: str = Field(description="Plan name (matches boulder plan_name)"),
    section: Literal[
        "learnings", "issues", "decisions", "problems", "questions"
    ] = Field(description="Notepad section to write to"),
    content: str = Field(description="Content to append (markdown)"),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Append content to a notepad section. Always appends, never overwrites."""
    state = _state_dir(working_directory)
    d = _notepad_dir(state, plan_name)
    path = os.path.join(d, f"{section}.md")

    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    entry = f"\n## {timestamp}\n\n{content}\n"

    with open(path, "a") as f:
        f.write(entry)

    return f"Appended to {plan_name}/{section}.md"


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def notepad_read(
    plan_name: str = Field(description="Plan name"),
    section: Literal["learnings", "issues", "decisions", "problems", "questions"]
    | None = Field(default=None, description="Section to read (all if omitted)"),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Read notepad content for a plan. Returns one section or all."""
    state = _state_dir(working_directory)
    d = os.path.join(state, NOTEPADS_DIR, plan_name)

    if not os.path.isdir(d):
        return f"No notepad found for plan: {plan_name}"

    sections = [section] if section else list(VALID_SECTIONS)
    output = []

    for s in sections:
        path = os.path.join(d, f"{s}.md")
        if os.path.isfile(path):
            with open(path) as f:
                content = f.read()
            output.append(f"# {s.title()}\n\n{content}")

    if not output:
        return f"No notepad entries found for plan: {plan_name}"

    return "\n---\n\n".join(output)


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def notepad_list(
    plan_name: str = Field(
        default="", description="Plan name (lists all plans if empty)"
    ),
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """List available notepads and their sections."""
    state = _state_dir(working_directory)
    notepads_root = os.path.join(state, NOTEPADS_DIR)

    if not os.path.isdir(notepads_root):
        return "No notepads found."

    if plan_name:
        d = os.path.join(notepads_root, plan_name)
        if not os.path.isdir(d):
            return f"No notepad found for plan: {plan_name}"
        sections = _list_notepad_sections(d)
        return f"Plan: {plan_name}\nSections: {', '.join(sections) if sections else 'empty'}"

    plans = sorted(
        d
        for d in os.listdir(notepads_root)
        if os.path.isdir(os.path.join(notepads_root, d))
    )
    if not plans:
        return "No notepads found."

    lines = ["Available notepads:\n"]
    for p in plans:
        d = os.path.join(notepads_root, p)
        sections = _list_notepad_sections(d)
        lines.append(f"- {p}: {', '.join(sections) if sections else 'empty'}")

    return "\n".join(lines)


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def agents_list(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Return structured catalog of all agents with orchestration metadata. Writes cache for hooks."""
    plugin_root = (
        Path(os.environ.get("CLAUDE_PLUGIN_ROOT", "")) or Path(__file__).parent.parent
    )
    agents_dir = plugin_root / "agents"
    metadata_path = plugin_root / "servers" / "agent-metadata.json"

    metadata = {}
    if metadata_path.exists():
        with contextlib.suppress(json.JSONDecodeError):
            metadata = json.loads(metadata_path.read_text())

    catalog = []
    if agents_dir.is_dir():
        for md_file in sorted(agents_dir.glob("*.md")):
            content = md_file.read_text()
            if content.startswith("---"):
                parts = content.split("---", 2)
                if len(parts) >= 3:
                    fm = yaml.safe_load(parts[1]) or {}
                    name = fm.get("name", md_file.stem)
                    meta = metadata.get(name, {})
                    catalog.append(
                        {
                            "name": name,
                            "description": fm.get("description", ""),
                            "default_model": fm.get("model", "sonnet"),
                            "agent_category": meta.get("agent_category", "specialist"),
                            "cost_tier": meta.get("cost_tier", "cheap"),
                            "preferred_category": meta.get(
                                "preferred_category", "standard"
                            ),
                            "when_to_use": meta.get("when_to_use", ""),
                            "when_not_to_use": meta.get("when_not_to_use", ""),
                            "key_trigger": meta.get("key_trigger", ""),
                        }
                    )

    state = _state_dir(working_directory)
    cache_path = os.path.join(state, AGENT_CATALOG_FILE)
    _write_json(cache_path, catalog)
    return json.dumps(catalog, indent=2)


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def categories_list(
    working_directory: str = Field(
        default="",
        description="Unused — reads from plugin dir. Kept for API consistency.",
    ),
) -> str:
    """Return category → model/prompt mapping from categories.json."""
    plugin_root = (
        Path(os.environ.get("CLAUDE_PLUGIN_ROOT", "")) or Path(__file__).parent.parent
    )
    config_path = plugin_root / "servers" / "categories.json"
    if not config_path.exists():
        return json.dumps({"error": "categories.json not found"})
    try:
        data = json.loads(config_path.read_text())
        return json.dumps(data, indent=2)
    except json.JSONDecodeError:
        return json.dumps({"error": "categories.json is malformed"})


@mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
def concurrency_status(
    working_directory: str = Field(
        default="", description="Project root (auto-detected from git)"
    ),
) -> str:
    """Read active agent counts from active-agents.json. Prunes stale entries (>15 min TTL)."""
    state = _state_dir(working_directory)
    active_path = os.path.join(state, "active-agents.json")

    try:
        with open(active_path) as f:
            agents = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return json.dumps({"active": [], "counts": {}, "total": 0})

    # Prune stale entries (>15 min)
    cutoff = time.time() - 900
    agents = [a for a in agents if a.get("started_epoch", 0) > cutoff]

    # Write back pruned list
    _write_json(active_path, agents)

    # Count by model
    counts: dict[str, int] = {}
    for a in agents:
        model = a.get("model", "unknown")
        counts[model] = counts.get(model, 0) + 1

    return json.dumps(
        {
            "active": agents,
            "counts": counts,
            "total": len(agents),
        },
        indent=2,
    )


# --- Signal handling & entry point ---

signal.signal(signal.SIGINT, signal.SIG_IGN)


def _graceful_exit(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, _graceful_exit)

if __name__ == "__main__":
    SG_BIN = discover_binary()
    print(f"omca MCP server starting (ast-grep: {SG_BIN})", file=sys.stderr)
    mcp.run()
