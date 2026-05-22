# Orchestration Workflow

> Surfaced on-demand by `scripts/context-injector.sh` when path-matched events fire — NOT injected per-turn.

## Pipeline

**prometheus → metis → momus → user approval → `/oh-my-claudeagent:start-work`.**

1. `prometheus` interviews user (optionally in Socratic Interview Mode), drafts plan.
2. `metis` gap-analyzes the draft.
3. `momus` reviews for clarity, verifiability, completeness.
4. **User approves** (ExitPlanMode or confirmation).
5. `/oh-my-claudeagent:start-work` executes the approved plan end-to-end at depth 0 — the main session (sisyphus identity) spawns `executor` for each task (parallel where the plan declares `Parallel Execution: YES`), invokes `oracle` for F1 independent review, logs evidence per task with `plan_sha256` (first-class field on `evidence_log`), and reports completion back to the user. The Plan Execution Mode protocol lives in `commands/start-work.md` body.

User runs `/oh-my-claudeagent:start-work [plan path]`.
Do not auto-start execution.
