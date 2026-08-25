"""Per-subagent status line renderer.

Entry point for the platform's ``subagentStatusLine`` hook (v2.1.197+): reads
one JSON object from stdin with a ``tasks`` array, emits one JSON line per
task to override that task's row in the tasks panel. Runnable directly via
``python3 -m statusline.subagent``, mirroring ``statusline.direct``.

Model resolution prefers the task payload's own ``model`` field (platform
v2.1.205+, reflecting the actual resolved model including per-call
``Agent(model=...)`` overrides the state file can't see) and falls back to
a PURE-READ lookup against ``.omca/state/subagent-models.json`` (written by
the SubagentStart hook, not owned by this module) for older platforms.
Must never crash the renderer -- an absent or malformed file just means
rows render without a model.

The documented payload (checked 2026-07-02) has no focused/selected field --
the platform renders the selection caret and owns Up/Down cycling itself.
Our job is one correct content line per task id; that per-id accuracy is
what makes cycling through tasks visibly meaningful.
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
    _visible_truncate,
    agent_glyph,
    build_glyphs,
    detect_nerd_font,
    terminal_columns,
)
from statusline.types import SubagentStatuslinePayload

_STATUS_COLOR = {
    "in_progress": YELLOW,
    "running": YELLOW,
    "pending": DIM,
    "completed": GREEN,
    "success": GREEN,
    "failed": RED,
    "error": RED,
}

_MODEL_ID_RE = re.compile(r"^claude-([a-z]+)-(\d+)(?:-(\d+))?$")

# Mirrors the alias arms in scripts/subagent-start.sh: both resolve the same
# alias (payload field here, state file there) and a row must not change case
# depending on which answered. `best`/`opusplan` name no generation, so they
# are deliberately absent and pass through unchanged.
_MODEL_ALIASES = frozenset({"opus", "sonnet", "fable", "haiku"})

# Observed-but-undocumented platform placeholder labels for a task's
# name/type when it hasn't (or can't) resolve a real agent name. Treated as
# "no name" so the state-file lookup gets a chance to supply the real one.
_GENERIC_NAMES = frozenset({"local_agent", "agent", "task"})


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


def _friendly_model(model_id: str) -> str:
    """Map a raw model id to its friendly display name.

    ``claude-<name>-<major>[-<minor>]`` becomes ``<Name> <major>[.<minor>]``
    (e.g. ``claude-sonnet-5`` -> ``Sonnet 5``, ``claude-opus-4-8`` ->
    ``Opus 4.8``) -- this must match the format the SubagentStart hook
    stores in ``subagent-models.json`` so rows never flicker between
    formats depending on which source resolved them. A bare tier alias in
    ``_MODEL_ALIASES`` becomes its capitalized, generation-less label for the
    same reason. Anything else (empty string, unrecognized future formats)
    passes through unchanged.
    """
    if model_id in _MODEL_ALIASES:
        return model_id.capitalize()
    match = _MODEL_ID_RE.match(model_id)
    if not match:
        return model_id
    name, major, minor = match.groups()
    version = f"{major}.{minor}" if minor else major
    return f"{name.capitalize()} {version}"


def _resolve_model(task: dict, models: dict) -> str:
    """Resolve a task's real model: payload field primary, state-file fallback.

    ``task["model"]`` (platform v2.1.205+) reflects the actual resolved
    model, including per-call ``Agent(model=...)`` overrides the state file
    can't see, so it wins whenever present. Older platforms omit the field,
    so fall back to the state-file lookup: ``task.id`` join primary, then
    matching ``task.name``/``task.type`` against the stored ``agent_type``.
    """
    raw_model = task.get("model") or ""
    if raw_model:
        return _friendly_model(raw_model)

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


def _strip_namespace(name: str) -> str:
    """Reduce a `<plugin>:<agent>` label to its last segment."""
    return name.rsplit(":", 1)[-1]


def _resolve_name(task: dict, models: dict) -> str:
    """Resolve a task's display name: state-file agent_type, then payload, then generic.

    The platform's own task name/type is sometimes a generic placeholder
    (see `_GENERIC_NAMES`) rather than the real agent. The SubagentStart
    hook records the real `agent_type` per task id in `subagent-models.json`,
    so prefer that when present; fall back to the payload label when it's
    meaningful; otherwise keep the generic label rather than inventing one.
    """
    entry = models.get(task.get("id", ""))
    if isinstance(entry, dict):
        agent_type = entry.get("agent_type", "") or ""
        if agent_type:
            return _strip_namespace(agent_type)

    payload_name = task.get("name") or task.get("type") or "agent"
    stripped = _strip_namespace(payload_name)
    if stripped in _GENERIC_NAMES:
        return payload_name
    return stripped


def _dump_payload(raw: str) -> None:
    """Append the raw stdin payload to the opt-in dump file, if configured.

    Exists to capture real payload shapes for platform-behavior questions
    (e.g. selection state) that the documented schema does not answer.
    Fail-open: any error writing the dump must never affect rendering.
    """
    dump_path = os.environ.get("OMCA_SUBAGENT_STATUSLINE_DUMP")
    if not dump_path:
        return
    try:
        with open(dump_path, "a", encoding="utf-8") as f:
            f.write(raw.rstrip("\n") + "\n")
    except OSError:
        pass


def _effort_label(task: dict) -> str:
    """Render a task's ``effort`` value, or "" when the field is absent.

    The per-task field is a bare value, not the main status line's
    ``{"level": ...}`` dict: either one of the level strings (low, medium,
    high, xhigh, max) or a numeric token budget, which renders compact.
    Absence means the subagent inherits the session level, and the session
    level already shows on the main line, so nothing is rendered for it.
    """
    effort = task.get("effort")
    if isinstance(effort, bool) or effort is None:
        return ""
    if isinstance(effort, int):
        return _format_tokens(effort)
    if isinstance(effort, str):
        return effort.strip()
    return ""


def _render_row(
    task: dict, models: dict, glyphs: dict, nerd: bool, columns: int
) -> str:
    name = _resolve_name(task, models)
    glyph = agent_glyph(name, nerd)
    parts = [f"{WHITE}{glyph} {name}{RST}"]

    model = _resolve_model(task, models)
    if model:
        parts.append(f"{DIM}{glyphs['model']} {model}{RST}")

    status = task.get("status", "")
    if status:
        color = _STATUS_COLOR.get(status, DIM)
        parts.append(f"{color}{status}{RST}")

    effort = _effort_label(task)
    if effort:
        effort_glyph = "" if nerd else "E:"  # nf-fa-bolt
        parts.append(f"{YELLOW}{effort_glyph} {effort}{RST}")

    token_count = task.get("tokenCount")
    if isinstance(token_count, int) and token_count > 0:
        window = task.get("contextWindowSize")
        # A percentage is comparable across rows running on different windows;
        # the raw count is all that can be shown when the window is unknown.
        if isinstance(window, int) and window > 0:
            pct = min(100.0, token_count / window * 100.0)
            parts.append(f"{DIM}{pct:.0f}% ctx{RST}")
        else:
            parts.append(f"{DIM}{_format_tokens(token_count)} tok{RST}")

    return _visible_truncate(SEP.join(parts), columns)


def main() -> None:
    try:
        raw = sys.stdin.read()
        _dump_payload(raw)
        try:
            data: SubagentStatuslinePayload = json.loads(raw)
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
