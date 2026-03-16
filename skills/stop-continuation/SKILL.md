---
name: stop-continuation
description: Stop ALL continuation mechanisms for the current session — ralph loop, boulder state, and auto-continuation. Use when you need to pause automated work and take manual control.
allowed-tools: Bash
user-invocable: true
argument-hint: "[optional: reason]"
---

# Stop Continuation - Halt All Automated Work

Stops all continuation mechanisms for the current session.

---

## Activation Phrases

- "stop continuation"
- "stop everything"
- "pause automation"
- "take manual control"

---

## What This Stops

1. **Ralph Loop** — Clears `.omca/state/ralph-state.json`
2. **Boulder State** — Clears `.omca/state/boulder.json` (active work plan)

---

## Process

```bash
PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
RALPH_STATE="${PROJECT_ROOT}/.omca/state/ralph-state.json"
BOULDER_STATE="${PROJECT_ROOT}/.omca/state/boulder.json"

echo "Checking active continuation mechanisms..."

if [[ -f "${RALPH_STATE}" ]]; then
  echo "- Ralph Loop: ACTIVE — clearing"
  rm -f "${RALPH_STATE}"
else
  echo "- Ralph Loop: not active"
fi

if [[ -f "${BOULDER_STATE}" ]]; then
  echo "- Boulder State: ACTIVE — clearing"
  rm -f "${BOULDER_STATE}"
else
  echo "- Boulder State: not active"
fi

echo "Done."
```

After running, report which mechanisms were stopped and confirm:
"Session will not auto-continue. Resume with `/oh-my-claudeagent:ralph` or `/oh-my-claudeagent:start-work`."

If no state files exist: "No active continuation mechanisms detected. Nothing to cancel."

---

## When to Use Which

| Situation | Use |
|-----------|-----|
| Only ralph loop running, want to stop just that | `cancel-ralph` |
| Ralph + active work plan, want full reset | `stop-continuation` |
| Active boulder state needs clearing | `stop-continuation` |
| Not sure what is active — want clean slate | `stop-continuation` |
