"""Core rendering logic for Claude Code statusline.

All constants and rendering functions extracted from the standalone
scripts/statusline.py. The public entry point is render(data, git_info).
"""

from __future__ import annotations

import os

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

FALLBACK = "[claude]"

# ANSI 16-color palette
RST = "\033[0m"
DIM = "\033[90m"  # dim gray
CYAN = "\033[36m"
WHITE = "\033[37m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
MAGENTA = "\033[35m"
BLUE = "\033[34m"
BOLD = "\033[1m"

# Graduated block characters (index 0 = thinnest, 7 = full block)
GRAD_BLOCKS = "\u258f\u258e\u258d\u258c\u258b\u258a\u2589\u2588"
EMPTY_BLOCK = "\u2591"

# Dim mid-dot separator
SEP = f" {DIM}\u00b7{RST} "

# Git cache TTL in seconds
GIT_CACHE_TTL = 5


# ---------------------------------------------------------------------------
# Nerd Font detection
# ---------------------------------------------------------------------------


def detect_nerd_font() -> bool:
    """Check env vars for Nerd Font preference. Default: true."""
    val = os.environ.get("CLAUDE_STATUSLINE_NERD_FONT")
    if val is not None:
        return val.strip() == "1"
    val = os.environ.get("NERD_FONT")
    if val is not None:
        return val.strip() == "1"
    return True


def build_glyphs(nerd: bool) -> dict[str, str]:
    """Return glyph dict with nerd font or ASCII variants."""
    if nerd:
        return {
            "branch": "\ue725",  # nf-dev-git_branch
            "folder": "\uf07c",  # nf-fa-folder_open
            "model": "\uf135",  # nf-fa-rocket
            "cost": "$",  # plain dollar -- nerd dollar glyphs are double-width
            "clock": "\uf017",  # nf-fa-clock_o
            "added": "+",  # keep simple -- nerd plus glyphs are too wide for counts
            "removed": "-",
            "vim": "\ue7c5",  # nf-md-vim
            "agent": "\uf544",  # nf-mdi-robot
            "worktree": "\ue728",  # nf-dev-git_merge
            "style": "\uf10c",  # nf-fa-circle_o
        }
    return {
        "branch": "*",
        "folder": ">",
        "model": ">",
        "cost": "$",
        "clock": "~",
        "added": "+",
        "removed": "-",
        "vim": "V:",
        "agent": "A:",
        "worktree": "W:",
        "style": "S:",
    }


# ---------------------------------------------------------------------------
# Context bar renderer
# ---------------------------------------------------------------------------


def _threshold_color(pct: float) -> str:
    """Return ANSI color based on percentage thresholds."""
    if pct >= 85:
        return RED
    if pct >= 60:
        return YELLOW
    return GREEN


def _render_context_bar(
    pct: float | None,
    ctx_window: dict,
    exceeds_200k: bool,
    bar_width: int = 20,
) -> str:
    """Render the context usage bar with graduated blocks."""
    ctx_size = ctx_window.get("context_window_size", 200000)
    size_label = "1M" if ctx_size >= 1000000 else "200k"

    # Determine percentage
    effective_pct = pct

    if effective_pct is None:
        # Try manual calculation from current_usage
        usage = ctx_window.get("current_usage")
        if usage is not None and ctx_size > 0:
            input_t = usage.get("input_tokens", 0) or 0
            cache_create = usage.get("cache_creation_input_tokens", 0) or 0
            cache_read = usage.get("cache_read_input_tokens", 0) or 0
            effective_pct = (input_t + cache_create + cache_read) / ctx_size * 100
        else:
            # Truly null -- show waiting placeholder
            empty_bar = f"{DIM}{EMPTY_BLOCK * bar_width}{RST}"
            return f"{empty_bar} {DIM}[waiting...]{RST}  {DIM}{size_label}{RST}"

    # Clamp
    effective_pct = max(0.0, min(100.0, effective_pct))

    color = _threshold_color(effective_pct)

    # Build graduated bar
    fill_exact = effective_pct / 100.0 * bar_width
    full_blocks = int(fill_exact)
    remainder = fill_exact - full_blocks

    bar_chars = []
    for i in range(bar_width):
        if i < full_blocks:
            bar_chars.append(f"{color}\u2588{RST}")  # full block
        elif i == full_blocks and remainder > 0:
            # Graduated partial block (8 levels)
            grad_idx = int(remainder * 8)
            grad_idx = min(grad_idx, 7)
            bar_chars.append(f"{color}{GRAD_BLOCKS[grad_idx]}{RST}")
        else:
            bar_chars.append(f"{DIM}{EMPTY_BLOCK}{RST}")

    bar_str = "".join(bar_chars)

    # Percentage text
    pct_text = f"{color}{effective_pct:.0f}%{RST}"

    # exceeds_200k warning -- ONLY on 200k windows
    warn = ""
    if exceeds_200k and ctx_size <= 200000:
        warn = f" {RED}{BOLD}!{RST}"

    return f"{bar_str} {pct_text}{warn}  {DIM}{size_label}{RST}"


# ---------------------------------------------------------------------------
# OSC 8 clickable link helper
# ---------------------------------------------------------------------------


def _osc8_link(url: str, text: str) -> str:
    """Wrap text in an OSC 8 hyperlink."""
    return f"\033]8;;{url}\a{text}\033]8;;\a"


def _remote_to_url(remote: str) -> str:
    """Convert git remote URL to HTTPS URL for linking."""
    if not remote:
        return ""
    url = remote
    if url.startswith("git@"):
        # git@github.com:user/repo.git -> https://github.com/user/repo
        url = url.replace(":", "/", 1).replace("git@", "https://", 1)
    if url.endswith(".git"):
        url = url[:-4]
    return url


# ---------------------------------------------------------------------------
# Duration formatter
# ---------------------------------------------------------------------------


def _format_duration(ms: int | None) -> str:
    """Format milliseconds to 'Xm Ys' string."""
    if ms is None:
        return "0m 0s"
    total_s = ms // 1000
    minutes = total_s // 60
    seconds = total_s % 60
    return f"{minutes}m {seconds}s"


# ---------------------------------------------------------------------------
# Line composers
# ---------------------------------------------------------------------------


def _compose_line1(
    data: dict,
    glyphs: dict[str, str],
    git_info: dict[str, str],
) -> tuple[str, bool]:
    """Compose info line (Line 1). Returns (line_str, has_extra_info)."""
    parts: list[str] = []
    has_extra = False

    # Model name (cyan)
    model = data.get("model", {})
    display_name = model.get("display_name", "Claude")
    parts.append(f"{CYAN}{glyphs['model']} {display_name}{RST}")

    # Git branch (or worktree branch override)
    worktree = data.get("worktree") if "worktree" in data else None
    branch_name = None
    if worktree and worktree.get("branch"):
        branch_name = worktree["branch"]
    elif git_info.get("is_git") == "1":
        branch_name = git_info.get("branch", "")

    if branch_name:
        has_extra = True
        parts.append(f"{WHITE}{glyphs['branch']} {branch_name}{RST}")

        # Git status counts
        git_status_parts = []
        modified = int(git_info.get("modified", "0"))
        staged = int(git_info.get("staged", "0"))
        untracked = int(git_info.get("untracked", "0"))

        if modified > 0:
            git_status_parts.append(f"{YELLOW}~{modified}{RST}")
        if staged > 0:
            git_status_parts.append(f"{GREEN}+{staged}{RST}")
        if untracked > 0:
            git_status_parts.append(f"{DIM}?{untracked}{RST}")

        if git_status_parts:
            parts.append("  ".join(git_status_parts))

    # Directory name -- show project basename, and repo link if remote available
    workspace = data.get("workspace", {})
    project_dir = workspace.get("project_dir", data.get("cwd", ""))
    dir_name = os.path.basename(project_dir) if project_dir else ""

    if dir_name:
        remote_url = _remote_to_url(git_info.get("remote", ""))
        if remote_url:
            linked = _osc8_link(remote_url, dir_name)
            parts.append(f"{DIM}{glyphs['folder']} {linked}{RST}")
        else:
            parts.append(f"{DIM}{glyphs['folder']} {dir_name}{RST}")

    # Added dirs count
    added_dirs = workspace.get("added_dirs")
    if added_dirs and len(added_dirs) > 0:
        has_extra = True
        count = len(added_dirs)
        parts.append(f"{DIM}+{count} dir{'s' if count != 1 else ''}{RST}")

    # Agent
    if "agent" in data and data["agent"] is not None:
        has_extra = True
        agent_name = data["agent"].get("name", "")
        if agent_name:
            parts.append(f"{MAGENTA}{glyphs['agent']} {agent_name}{RST}")

    # Worktree
    if worktree is not None:
        has_extra = True
        wt_name = worktree.get("name", "")
        if wt_name:
            wt_str = f"{BLUE}{glyphs['worktree']} {wt_name}{RST}"
            orig_branch = worktree.get("original_branch")
            if orig_branch:
                wt_str += f" {DIM}<- {orig_branch}{RST}"
            parts.append(wt_str)

    # Output style (only if not "default")
    output_style = data.get("output_style", {}).get("name", "default")
    if output_style and output_style != "default":
        has_extra = True
        parts.append(f"{DIM}{glyphs['style']} {output_style}{RST}")

    # Vim mode (end of line)
    if "vim" in data and data["vim"] is not None:
        has_extra = True
        vim_mode = data["vim"].get("mode", "")
        if vim_mode:
            short = vim_mode[0] if vim_mode else "?"
            parts.append(f"{YELLOW}{glyphs['vim']} {short}{RST}")

    line = SEP.join(parts)
    return line, has_extra


def _compose_line2(
    data: dict,
    glyphs: dict[str, str],
) -> str:
    """Compose metrics line (Line 2)."""
    parts: list[str] = []

    # Context bar
    ctx_window = data.get("context_window", {})
    used_pct = ctx_window.get("used_percentage")
    exceeds = data.get("exceeds_200k_tokens", False)
    bar = _render_context_bar(used_pct, ctx_window, exceeds)
    parts.append(bar)

    # Cost
    cost_data = data.get("cost", {})
    cost_usd = cost_data.get("total_cost_usd")
    if cost_usd is not None:
        parts.append(f"{MAGENTA}{glyphs['cost']}{cost_usd:.2f}{RST}")
    else:
        parts.append(f"{MAGENTA}{glyphs['cost']}0.00{RST}")

    # Duration
    duration_ms = cost_data.get("total_duration_ms")
    dur_str = _format_duration(duration_ms)
    parts.append(f"{BLUE}{glyphs['clock']} {dur_str}{RST}")

    # Lines changed
    lines_added = cost_data.get("total_lines_added")
    lines_removed = cost_data.get("total_lines_removed")
    line_parts = []
    if lines_added is not None and lines_added > 0:
        line_parts.append(f"{GREEN}{glyphs['added']}{lines_added}{RST}")
    if lines_removed is not None and lines_removed > 0:
        line_parts.append(f"{RED}{glyphs['removed']}{lines_removed}{RST}")
    if line_parts:
        parts.append("/".join(line_parts))

    return SEP.join(parts)


# ---------------------------------------------------------------------------
# Public render function
# ---------------------------------------------------------------------------


def render(data: dict, git_info: dict) -> str:
    """Render the statusline from parsed JSON data and git info.

    Returns a string of 1 or 2 lines joined by newline.
    The caller decides whether to print or send over socket.
    """
    nerd = detect_nerd_font()
    glyphs = build_glyphs(nerd)

    # Compose lines
    line1, has_extra = _compose_line1(data, glyphs, git_info)
    line2 = _compose_line2(data, glyphs)

    # Adaptive layout
    is_git = git_info.get("is_git") == "1"
    has_agent = "agent" in data and data["agent"] is not None
    has_worktree = "worktree" in data and data["worktree"] is not None
    has_vim = "vim" in data and data["vim"] is not None

    use_two_lines = is_git or has_agent or has_worktree or has_vim or has_extra

    if use_two_lines:
        return f"{line1}\n{line2}"

    # Single line: model + bar + cost + duration
    parts = []
    model = data.get("model", {})
    display_name = model.get("display_name", "Claude")
    parts.append(f"{CYAN}{glyphs['model']} {display_name}{RST}")

    ctx_window = data.get("context_window", {})
    used_pct = ctx_window.get("used_percentage")
    exceeds = data.get("exceeds_200k_tokens", False)
    bar = _render_context_bar(used_pct, ctx_window, exceeds)
    parts.append(bar)

    cost_data = data.get("cost", {})
    cost_usd = cost_data.get("total_cost_usd")
    if cost_usd is not None:
        parts.append(f"{MAGENTA}{glyphs['cost']}{cost_usd:.2f}{RST}")
    else:
        parts.append(f"{MAGENTA}{glyphs['cost']}0.00{RST}")

    duration_ms = cost_data.get("total_duration_ms")
    dur_str = _format_duration(duration_ms)
    parts.append(f"{BLUE}{glyphs['clock']} {dur_str}{RST}")

    return SEP.join(parts)
