---
name: plan
description: Create a strategic work plan via Prometheus-style interview and structured plan drafting.
argument-hint: "[work description]"
---

# Plan Command — Prometheus Planning Entrypoint

Invoke prometheus planning protocol at depth 0. User provides work description via `$ARGUMENTS`.

## Protocol

Follow `agents/prometheus.md` end-to-end:

**Phase 1: Interview**: Route on outcome clarity FIRST (CLEAR / UNCLEAR / ON-THE-FENCE, prometheus.md Step 0); UNCLEAR skips the interview and applies announced defaults instead. Classify work intent (trivial/simple/complex/build/refactor/architecture/research). Apply Simple Request Detection. Run Exploration Gate: mandatory for Build from Scratch, Research, Architecture; scoped for Refactoring; skip for Trivial. Once exploration returns and before interviewing, write the plan file with `**Status**: DRAFT` on its metadata line, numbered `- [ ] N.` tasks from that first write (a checkbox-free plan write is denied by the plan-write validator), and an `## Open questions` section carrying a stated default per question. Interview against that file: the user corrects something concrete instead of answering abstract questions, so the interview gets shorter, not longer. Use `AskUserQuestion` for targeted interview questions; fall back to `## BLOCKING QUESTIONS` block if unavailable. Run Self-Clearance Check after every interview turn. All 10 items YES → auto-transition. Any NO → ask the specific unclear question.

**Phase 2 — Plan Generation**: Rewrite the DRAFT in place to `**Status**: FINAL` with one full-file `Write`, never an Edit of the Status line alone, and only then call `boulder_write`. Consult metis before generating. Write plan to `<plans-dir>/{name}.md` or the active plan-mode file. `<plans-dir>` is the `plansDirectory` setting when set (relative to the project root), otherwise `~/.claude/plans`. Resolve it from settings instead of assuming the default, or the plan lands where nothing looks for it. Enforce task checkboxes (`- [ ] N.`). Run the momus review loop by invoking the `oh-my-claudeagent:momus` skill (via the Skill tool) with the plan file path — max 3 iterations until OKAY.

**Phase 3 — Handoff**: After momus OKAY, confirm next steps with user via `AskUserQuestion`. Guide to `/oh-my-claudeagent:start-work` for execution.

## Delegation

Delegate exploration to `explore` agents (parallel when topics are independent). Delegate external research to `librarian`. Delegate implementation to `oh-my-claudeagent:executor` — never implement directly from this command.

## Constraints

- Planner only. No code. No task execution.
- Single deliverable plan regardless of size.
- Plans always in English.
- No `context: fork` passed to `Agent()` spawn calls (explore/executor/librarian). This does NOT restrict invoking agent-command skills such as `metis`/`momus`, which declare `context: fork` in their own frontmatter.
- Always use `oh-my-claudeagent:executor` as subagent_type for implementation delegation.

## Socratic Interview Mode

If the request is underspecified or architectural in nature, enter Socratic Interview Mode (now part of prometheus — see `agents/prometheus.md` "Socratic Interview Mode" section) before entering Phase 1. Socratic mode surfaces hidden constraints and clarifies fuzzy problem statements via iterative dialogue. In Socratic mode, prometheus does NOT write a plan file — it returns synthesis only.
