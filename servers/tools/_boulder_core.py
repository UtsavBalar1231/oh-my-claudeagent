"""Stdlib-only boulder registry core: schema migration + pure-read resolution.

No fastmcp/pydantic imports here — this module is shared by the MCP server
(``boulder.py``), the bash-callable resolver shim (``boulder_resolve.py``),
the SessionStart GC shim (``boulder_gc.py``), and the statusline renderer,
which must all stay dependency-light enough to run as bare ``python3``.
"""

import re
from pathlib import Path

# Canonical numbered-checkbox pattern — matches `- [ ] 1.` / `- [x] 12.`.
# Single source of truth shared by boulder.py, boulder_gc.py, and statusline.
CHECKBOX_RE = re.compile(r"^- \[([ x])\] \d+\.", re.MULTILINE)

# Same checkbox anchor as CHECKBOX_RE, extended with a trailing capture group
# for the task label text, used only by next_task_label() below.
_CHECKBOX_LABEL_RE = re.compile(r"^- \[([ x])\] \d+\.\s*(.*)$", re.MULTILINE)

# 80 chars: keeps next_task_label a short resume hint, not a full restatement
# of the task (plan tasks routinely run to multiple sentences).
MAX_LABEL_LEN = 80


def next_task_label(content: str) -> str | None:
    """Return the text of the first unchecked numbered task, truncated for display.

    Uses the same checkbox anchor as CHECKBOX_RE. Returns None when the plan
    has no numbered checkboxes or every numbered checkbox is checked.
    """
    for state, label in _CHECKBOX_LABEL_RE.findall(content):
        if state.lower() != "x":
            label = label.strip()
            if len(label) > MAX_LABEL_LEN:
                label = label[: MAX_LABEL_LEN - 1].rstrip() + "…"
            return label
    return None


def plan_is_complete(active_plan: str) -> bool:
    """Derive completion from plan-file checkboxes — no stored completed_at.

    A plan with no numbered checkboxes is never complete. Unreadable or
    missing files return False (missing-file pruning is a separate, explicit
    decision in gc_prune_unbound — not conflated with completion).
    """
    if not active_plan:
        return False
    try:
        content = Path(active_plan).read_text()
    except OSError:
        return False
    matches = CHECKBOX_RE.findall(content)
    return bool(matches) and all(m.lower() == "x" for m in matches)


def gc_prune_unbound(registry: dict) -> dict:
    """Prune finished or orphaned plans no session is bound to. Mutates in place.

    Removes, in order: bindings whose plan_name no longer exists in `plans`;
    then any plan that is simultaneously unbound AND (checkbox-complete, OR
    missing its plan file, OR lacking an active_plan path). Incomplete plans
    with a live file are always kept, bound or not — they are resumable work.
    Returns {"pruned_plans": [...], "pruned_bindings": [...]}.
    """
    plans = registry["plans"]
    bindings = registry["bindings"]

    orphan_bindings = [
        sid for sid, b in bindings.items() if b.get("plan_name") not in plans
    ]
    for sid in orphan_bindings:
        del bindings[sid]

    bound_names = {b.get("plan_name") for b in bindings.values()}
    pruned_plans = []
    for name in list(plans):
        if name in bound_names:
            continue
        path = plans[name].get("active_plan", "")
        if not path or not Path(path).exists() or plan_is_complete(path):
            del plans[name]
            pruned_plans.append(name)
    return {"pruned_plans": pruned_plans, "pruned_bindings": orphan_bindings}


def is_flat_schema(data: dict) -> bool:
    """True when `data` is the old single-plan flat schema.

    Old schema: top-level `active_plan` key, no `plans`/`bindings` registry keys.
    """
    return bool(data) and "active_plan" in data and "plans" not in data


def migrate_flat_to_registry(data: dict) -> dict:
    """Convert an old flat boulder.json dict into the registry shape, in-memory.

    Pure transform — never writes. Preserves `started_at`/`session_ids`/`agent`/
    `worktree_path` into `plans[plan_name]`. Old schema predates bindings, so
    `bindings` starts empty; callers that migrate on a write path add the
    writing session's binding themselves.
    """
    plan_name = data.get("plan_name")
    if not plan_name:
        return {"plans": {}, "bindings": {}}
    plan_entry = {
        "active_plan": data.get("active_plan", ""),
        "started_at": data.get("started_at", ""),
        "session_ids": list(data.get("session_ids") or []),
        "agent": data.get("agent", "sisyphus"),
    }
    if data.get("worktree_path"):
        plan_entry["worktree_path"] = data["worktree_path"]
    return {"plans": {plan_name: plan_entry}, "bindings": {}}


def normalize(data: dict) -> dict:
    """Return a registry-shaped `{plans, bindings}` dict for `data`.

    Migrates the old flat schema in-memory when detected. Pure — never writes.
    Malformed/empty input yields an empty registry.
    """
    if not isinstance(data, dict):
        return {"plans": {}, "bindings": {}}
    if is_flat_schema(data):
        return migrate_flat_to_registry(data)
    plans = data.get("plans")
    bindings = data.get("bindings")
    return {
        "plans": plans if isinstance(plans, dict) else {},
        "bindings": bindings if isinstance(bindings, dict) else {},
    }


def _plan_triple(plan_name: str, plan_entry: dict) -> dict:
    return {
        "plan_name": plan_name,
        "active_plan": plan_entry.get("active_plan", ""),
        "worktree_path": plan_entry.get("worktree_path", ""),
    }


def resolve_bound_plan(data: dict, session_id: str, strict: bool = False) -> dict:
    """Resolve which plan `session_id` is bound to. PURE-READ — never writes.

    Lenient ladder (`strict=False`, the default): explicit binding -> the sole
    registered plan -> the plan with the most recent `started_at` -> empty
    dict. Tolerates both the old flat schema and the new registry schema
    without persisting a migration. The two fallback rungs are resume
    plumbing for readers that tolerate ambiguity (`boulder_progress`, an
    explicit `plan_name` lookup): they let a session with no recorded
    binding still recover a plan when there is a reasonable single guess.

    Strict mode (`strict=True`): only an explicit `bindings[session_id]` entry
    resolves a plan; both fallback rungs are skipped and a session with no
    binding gets `{}`. Any enforcement or context-injection consumer (a Stop
    hook that blocks the session, a title or plan-context injector) must pass
    `strict=True`, otherwise an unbound session silently inherits whatever
    plan another session happens to be working on, which is exactly the
    failure the statusline's own strict, in-process resolution already avoids.
    """
    registry = normalize(data)
    plans = registry["plans"]
    bindings = registry["bindings"]

    if session_id:
        binding = bindings.get(session_id)
        if binding and binding.get("plan_name") in plans:
            plan_name = binding["plan_name"]
            return _plan_triple(plan_name, plans[plan_name])

    if strict:
        return {}

    if not plans:
        return {}
    if len(plans) == 1:
        ((plan_name, plan_entry),) = plans.items()
        return _plan_triple(plan_name, plan_entry)

    plan_name = max(plans, key=lambda name: plans[name].get("started_at", ""))
    return _plan_triple(plan_name, plans[plan_name])
