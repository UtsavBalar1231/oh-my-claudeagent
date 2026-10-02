"""Palette, glyph and width helpers the subagent status line renders with."""

from __future__ import annotations

import os
import re

RST = "\033[0m"
DIM = "\033[90m"
WHITE = "\033[37m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"

SEP = f" {DIM}\u00b7{RST} "

AGENT_GLYPHS_NERD: dict[str, str] = {
    "explore": "\uf14e",  # nf-fa-compass — exploration
    "hephaestus": "\uf0ad",  # nf-fa-wrench — smith
    "librarian": "\uf02d",  # nf-fa-book — library
    "metis": "\uf002",  # nf-fa-search — gap analysis
    "momus": "\uf075",  # nf-fa-comment — critique
    "multimodal-looker": "\uf030",  # nf-fa-camera — visual input
    "oracle": "\uf06e",  # nf-fa-eye — foresight
    "prometheus": "\uf06d",  # nf-fa-fire — stolen flame
    "sisyphus": "\uef08",  # nf-fa-mountain — boulder-pushing myth
    "executor": "\uf085",  # nf-fa-cogs — the doer, distinct from hephaestus's wrench
    "__default__": "\uf007",  # nf-fa-user — unknown-agent fallback
}

AGENT_GLYPH_ASCII: str = "A:"


def agent_glyph(agent_name: str, nerd: bool) -> str:
    """Return the thematic glyph for an agent, falling back cleanly.

    Strips the `oh-my-claudeagent:` namespace prefix before lookup so
    both bare names and namespaced names resolve identically.
    Non-nerd terminals always receive AGENT_GLYPH_ASCII.
    """
    if not nerd:
        return AGENT_GLYPH_ASCII
    key = agent_name.removeprefix("oh-my-claudeagent:")
    return AGENT_GLYPHS_NERD.get(key, AGENT_GLYPHS_NERD["__default__"])


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
    """Return the glyphs the subagent rows use, Nerd Font or ASCII."""
    return {"model": "\uf135" if nerd else ">"}  # nf-fa-rocket


def terminal_columns(payload_columns: int | None = None, default: int = 80) -> int:
    """Return the terminal column count for display-width decisions.

    Priority (highest to lowest):
    1. ``payload_columns`` — the ``columns`` field from the statusline JSON payload
       (most accurate, set by the platform from the actual PTY size).
    2. ``COLUMNS`` env var — set by bash/zsh from the terminal's reported width.
    3. ``default`` (80) — hard-coded fallback.
    """
    if payload_columns is not None and payload_columns > 0:
        return payload_columns
    env_cols = os.environ.get("COLUMNS")
    if env_cols and env_cols.isdigit():
        val = int(env_cols)
        if val > 0:
            return val
    return default


# SGR colors and OSC 8 hyperlink delimiters occupy no terminal columns, so the
# truncator must step over them whole: slicing one in half emits the remainder
# as literal text and leaves the terminal in the escape's state.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)")
_OSC8_CLOSERS = ("\x1b]8;;\x07", "\x1b]8;;\x1b\\")


def _visible_truncate(s: str, width: int) -> str:
    """Truncate to `width` visible columns, passing ANSI codes through untouched."""
    if width <= 0:
        return ""
    out: list[str] = []
    visible = 0
    i = 0
    n = len(s)
    link_open = False
    while i < n:
        m = _ANSI_RE.match(s, i)
        if m:
            token = m.group()
            if token.startswith("\x1b]8;;"):
                link_open = token not in _OSC8_CLOSERS
            out.append(token)
            i = m.end()
            continue
        if visible >= width:
            break
        out.append(s[i])
        visible += 1
        i += 1
    # Cutting inside a hyperlink would leave every later line linked to its URL.
    if link_open:
        out.append(_OSC8_CLOSERS[0])
    return "".join(out) + RST


def _format_tokens(n: int) -> str:
    """Format a token count to a compact human-readable string."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)
