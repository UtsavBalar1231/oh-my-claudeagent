---
name: stop-continuation
description: Stop ALL continuation mechanisms for the current session — ralph loop, boulder state, and auto-continuation. Use when you need to pause automated work and take manual control.
user-invocable: true
argument-hint: "[optional: reason]"
---

# Stop Continuation - Halt All Automated Work

Stops all continuation mechanisms for the current session.

## What This Stops

1. **Ralph Loop** — Clears `.omca/state/ralph-state.json`
2. **Boulder State** — Clears `.omca/state/boulder.json` (active work plan)
3. **Ultrawork Mode** — Clears `.omca/state/ultrawork-state.json`

## Process

Use the `mode_clear` MCP tool with default mode ("all"):

```bash
mode_clear()
```

This clears ralph-state.json, ultrawork-state.json, and boulder.json in one call.

Report which mechanisms stopped: "Session will not auto-continue. Resume with `/oh-my-claudeagent:ralph` or `/oh-my-claudeagent:start-work`."

No state files: "No active continuation mechanisms detected. Nothing to cancel."

## When to Use Which

| Situation | Use |
|-----------|-----|
| Only ralph loop running, want to stop just that | `cancel-ralph` |
| Ralph + active work plan, want full reset | `stop-continuation` |
| Active boulder state needs clearing | `stop-continuation` |
| Not sure what is active — want clean slate | `stop-continuation` |
