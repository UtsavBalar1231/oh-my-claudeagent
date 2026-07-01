"""Per-subagent status line renderer.

Entry point for the platform's ``subagentStatusLine`` hook (v2.1.197+): reads
one JSON object from stdin with a ``tasks`` array, emits one JSON line per
task to override that task's row in the tasks panel. Runnable directly via
``python3 -m statusline.subagent``, mirroring ``statusline.direct``.

Model lookup is PURE-READ against ``.omca/state/subagent-models.json``
(written by the SubagentStart hook, not owned by this module) and must
never crash the renderer -- an absent or malformed file just means rows
render without a model.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from statusline.core import (
    DIM,
    GREEN,
    RED,
    RST,
    SEP,
    WHITE,
    YELLOW,
    _format_tokens,
    agent_glyph,
    build_glyphs,
    detect_nerd_font,
    terminal_columns,
)

_STATUS_COLOR = {
    "in_progress": YELLOW,
    "running": YELLOW,
    "pending": DIM,
    "completed": GREEN,
    "success": GREEN,
    "failed": RED,
    "error": RED,
}

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _load_models(cwd: str) -> dict:
    """Read the subagent-model map for a task's project dir.

    Returns {} on any error (absent file, malformed JSON, non-dict) --
    the renderer must degrade to model-less rows rather than crash.
    """
    if not cwd:
        return {}
    path = Path(cwd) / ".omca" / "state" / "subagent-models.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_model(task: dict, models: dict) -> str:
    """Resolve a task's real model: id-join primary, name/type fallback.

    ``task.id`` is unique per spawn so it's the primary join key; the
    fallback matches ``task.name``/``task.type`` against the stored
    ``agent_type`` for state files keyed differently than expected.
    """
    entry = models.get(task.get("id", ""))
    if entry is None:
        agent_type = task.get("name") or task.get("type") or ""
        for stored in models.values():
            if isinstance(stored, dict) and stored.get("agent_type") == agent_type:
                entry = stored
                break
    if not isinstance(entry, dict):
        return ""
    return entry.get("model", "") or ""


def _visible_truncate(s: str, width: int) -> str:
    """Truncate to `width` visible columns, passing ANSI codes through untouched."""
    if width <= 0:
        return ""
    out: list[str] = []
    visible = 0
    i = 0
    n = len(s)
    while i < n:
        m = _ANSI_RE.match(s, i)
        if m:
            out.append(m.group())
            i = m.end()
            continue
        if visible >= width:
            break
        out.append(s[i])
        visible += 1
        i += 1
    return "".join(out) + RST


def _render_row(
    task: dict, models: dict, glyphs: dict, nerd: bool, columns: int
) -> str:
    name = (task.get("name") or task.get("type") or "agent").removeprefix(
        "oh-my-claudeagent:"
    )
    glyph = agent_glyph(name, nerd)
    parts = [f"{WHITE}{glyph} {name}{RST}"]

    model = _resolve_model(task, models)
    if model:
        parts.append(f"{DIM}{glyphs['model']} {model}{RST}")

    status = task.get("status", "")
    if status:
        color = _STATUS_COLOR.get(status, DIM)
        parts.append(f"{color}{status}{RST}")

    token_count = task.get("tokenCount")
    if isinstance(token_count, int) and token_count > 0:
        parts.append(f"{DIM}{_format_tokens(token_count)} tok{RST}")

    return _visible_truncate(SEP.join(parts), columns)


def main() -> None:
    try:
        try:
            data = json.load(sys.stdin)
        except (json.JSONDecodeError, ValueError):
            return

        if not isinstance(data, dict):
            return
        tasks = data.get("tasks")
        if not isinstance(tasks, list):
            return

        columns = terminal_columns(data.get("columns"))
        nerd = detect_nerd_font()
        glyphs = build_glyphs(nerd)
        models_cache: dict[str, dict] = {}
        # The SubagentStart capture writes ONE state file at the main session's
        # .omca/state. Locate it via the top-level payload cwd, falling back to
        # CLAUDE_PROJECT_ROOT (the root the hook writes under), then per-task cwd.
        base_cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_ROOT", "")

        for task in tasks:
            if not isinstance(task, dict):
                continue
            task_id = task.get("id")
            if not task_id:
                continue
            cwd = base_cwd or (task.get("cwd", "") or "")
            if cwd not in models_cache:
                models_cache[cwd] = _load_models(cwd)
            content = _render_row(task, models_cache[cwd], glyphs, nerd, columns)
            print(json.dumps({"id": task_id, "content": content}))
    except Exception:
        # Statusline must never break the prompt -- swallow and emit nothing.
        return


if __name__ == "__main__":
    main()
