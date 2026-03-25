---
name: ulw-loop
description: "Ultrawork persistence loop. Like ralph, but requires Oracle verification before the loop exits. No iteration limit — only oracle-verified completion exits. Triggers: 'ulw-loop', 'ultrawork loop', 'oracle loop'."
model: sonnet
user-invocable: true
effort: high
---

# ULW Loop — Oracle-Verified Persistence

## Tool Restrictions

This is an orchestration loop. DO NOT implement directly:
- **Write** / **Edit** — Delegate all implementation to agents

MCP tools available: `mode_read`, `mode_clear`, `boulder_progress`, `evidence_log`, `evidence_read`.

## Activation

Sets both ralph mode AND ultrawork mode. Activation writes `.omca/state/ralph-state.json` and `.omca/state/ultrawork-state.json`. See `/oh-my-claudeagent:ralph` and `/oh-my-claudeagent:ultrawork` skills for the state file format and keyword triggers. The session persists until:
1. ALL tasks are complete
2. Oracle has verified the work
3. Oracle verdict is APPROVE

## Workflow

1. Activate ralph mode (`.omca/state/ralph-state.json`)
2. Activate ultrawork mode (`.omca/state/ultrawork-state.json`)
3. Execute tasks with maximum parallelism
4. When all tasks appear complete:
   - Spawn Oracle: `Agent(subagent_type="oh-my-claudeagent:oracle", prompt="Verify all completed work...")`
   - If Oracle APPROVES: deactivate both modes, allow session end
   - If Oracle REJECTS: fix issues, re-verify
5. Loop continues until Oracle approves

## Key Difference from Ralph

| | Ralph | ULW Loop |
|---|---|---|
| Exit condition | All tasks complete | All tasks complete + Oracle APPROVE |
| Parallelism | Normal | Maximum (ultrawork) |
| Verification | Evidence-based | Oracle-verified |
