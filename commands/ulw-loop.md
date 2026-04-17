---
name: ulw-loop
description: "Ultrawork persistence loop. Like ralph, but requires Oracle verification before the loop exits. No iteration limit — only oracle-verified completion exits."
argument-hint: "[task description]"
---

# ULW Loop — Oracle-Verified Persistence

## Tool Restrictions

Orchestration loop. No direct implementation — delegate via agents.

MCP tools: `mode_read`, `mode_clear`, `boulder_progress`, `evidence_log`, `evidence_read`.

## Activation

Registers ralph (persistence) + ultrawork (parallelism). Session persists until ALL tasks complete AND Oracle APPROVES.

## Workflow

1. Activate ralph + ultrawork modes
2. Execute with maximum parallelism
3. All tasks appear complete → spawn Oracle for verification
4. Oracle APPROVES → deactivate modes, allow session end
5. Oracle REJECTS → fix, re-verify. Loop until approved.

## Key Difference from Ralph

| | Ralph | ULW Loop |
|---|---|---|
| Exit condition | All tasks complete | All tasks complete + Oracle APPROVE |
| Parallelism | Normal | Maximum (ultrawork) |
| Verification | Evidence-based | Oracle-verified |

## Delegation

Delegate all implementation to `oh-my-claudeagent:executor`. Spawn agents in parallel batches per the ultrawork pattern (max 5 concurrent). Apply the Background Agent Barrier: on partial completion, acknowledge and END response; synthesize only after all agents report.
