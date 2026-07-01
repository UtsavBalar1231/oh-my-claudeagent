"""Stdlib-only boulder registry core: schema migration + pure-read resolution.

No fastmcp/pydantic imports here — this module is shared by the MCP server
(``boulder.py``) AND the bash-callable resolver shim (``boulder_resolve.py``),
which must stay dependency-light enough to run as a bare ``python3`` script.
"""


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


def resolve_bound_plan(data: dict, session_id: str) -> dict:
    """Resolve which plan `session_id` is bound to. PURE-READ — never writes.

    Ladder: explicit binding -> the sole registered plan -> the plan with the
    most recent `started_at` -> empty dict. Tolerates both the old flat schema
    and the new registry schema without persisting a migration.
    """
    registry = normalize(data)
    plans = registry["plans"]
    bindings = registry["bindings"]

    if session_id:
        binding = bindings.get(session_id)
        if binding and binding.get("plan_name") in plans:
            plan_name = binding["plan_name"]
            return _plan_triple(plan_name, plans[plan_name])

    if not plans:
        return {}
    if len(plans) == 1:
        ((plan_name, plan_entry),) = plans.items()
        return _plan_triple(plan_name, plan_entry)

    plan_name = max(plans, key=lambda name: plans[name].get("started_at", ""))
    return _plan_triple(plan_name, plans[plan_name])
