---
name: plan
description: Create a strategic work plan via Prometheus-style interview and structured plan drafting.
argument-hint: "[work description]"
---

# Plan Command — Prometheus Planning Entrypoint

Invoke prometheus planning protocol at depth 0. User provides work description via `$ARGUMENTS`.

## Protocol

Follow `agents/prometheus.md` end-to-end:

**Phase 1 — Interview**: Classify work intent (trivial/simple/complex/build/refactor/architecture/research). Apply Simple Request Detection. Run Exploration Gate — mandatory for Build from Scratch, Research, Architecture; scoped for Refactoring; skip for Trivial. Use `AskUserQuestion` for targeted interview questions; fall back to `## BLOCKING QUESTIONS` block if unavailable. Run Self-Clearance Check after every interview turn. All 10 items YES → auto-transition. Any NO → ask the specific unclear question.

**Phase 2 — Plan Generation**: Consult metis before generating. Write plan to `.claude/plans/{name}.md` or active plan-mode file. Enforce task checkboxes (`- [ ] N.`). Run momus review loop (max 3 iterations) until OKAY.

**Phase 3 — Handoff**: After momus OKAY, confirm next steps with user via `AskUserQuestion`. Guide to `/oh-my-claudeagent:start-work` for execution.

## Delegation

Delegate exploration to `explore` agents (parallel when topics are independent). Delegate external research to `librarian`. Delegate implementation to `oh-my-claudeagent:executor` — never implement directly from this command.

## Constraints

- Planner only. No code. No task execution.
- Single deliverable plan regardless of size.
- Plans always in English.
- No `context: fork` in any spawned agent calls.
- Always use `oh-my-claudeagent:executor` as subagent_type for implementation delegation.

## Socratic Interview Mode

If the request is underspecified or architectural in nature, enter Socratic Interview Mode (now part of prometheus — see `agents/prometheus.md` "Socratic Interview Mode" section) before entering Phase 1. Socratic mode surfaces hidden constraints and clarifies fuzzy problem statements via iterative dialogue. In Socratic mode, prometheus does NOT write to `.claude/plans/` — it returns synthesis only.
