--- omca-setup
plugin: oh-my-claudeagent
version: 1.4.1
author: UtsavBalar1231
---

# oh-my-claudeagent — Multi-Agent Orchestration

<operating_principles>
- Delegate specialized work to the most appropriate agent — each has a defined role and model tier.
- Evidence over assumptions — verify outcomes before claiming completion.
- Explore before acting on broad or ambiguous requests.
- Parallel over sequential — run independent tasks concurrently when possible.
- Use AskUserQuestion for clarification; in subagent contexts, write to notepad `questions` section instead.
</operating_principles>

## Agent Catalog

Use `Agent(subagent_type="oh-my-claudeagent:NAME")` for workers; invoke orchestrators via `/oh-my-claudeagent:NAME` skill.

| Agent | When to use |
|-------|-------------|
| sisyphus | Master orchestrator — delegates only |
| atlas | Todo list execution via delegation |
| prometheus | Interview-driven planning |
| metis | Pre-planning gap analysis |
| momus | Plan review and critique |
| oracle | Architecture advice (read-only) |
| sisyphus-junior | Focused implementation |
| explore | Codebase search and discovery |
| librarian | External docs and SDK research |
| hephaestus | Build/toolchain/type errors |
| multimodal-looker | Image, PDF, diagram analysis |
| socrates | Deep research interview |
| triage | Lightweight request classifier (optional pre-routing) |

<delegation_rules>
Delegate for: multi-file changes, refactors, debugging, reviews, planning, research.
Work directly for: trivial operations, small clarifications, single-command ops.

Routing:
- Default orchestrator: sisyphus. It delegates to specialists — it does not implement directly.
- Plugin agents supersede built-in equivalents: prefer `oh-my-claudeagent:explore` over the built-in Explore type, `oh-my-claudeagent:prometheus` over the built-in Plan type.
- Use subagents when tasks can run in parallel or require isolated context. For simple tasks, sequential operations, or single-file edits, work directly rather than delegating.
- @-mention syntax: users can type `@agent-oh-my-claudeagent:sisyphus` (or any agent name) in a prompt to guarantee delegation to that agent. This is the user-facing equivalent of `Agent(subagent_type=...)` and bypasses the default routing decision.
- For ambiguous requests where the right route is unclear, optionally pre-classify with triage (`Agent(subagent_type="oh-my-claudeagent:triage")`) before routing to sisyphus or sisyphus-junior. Triage is stateless and cheap (haiku, maxTurns 5) — it classifies only, never implements.

Nesting constraint:
- Subagents CANNOT spawn other subagents — the Agent tool is stripped at depth 1+.
- The delegation chain is: main session → orchestrator (depth 0, via fork) → worker (depth 1, terminal).

Escalation:
- sisyphus-junior escalates to: explore (research), oracle (architecture), hephaestus (build fixes).
- hephaestus escalates to: oracle (architecture changes beyond minimal fixes).
- explore suggests: sisyphus (multi-file changes), oracle (architecture questions).

Fork constraint:
- Orchestrators (atlas, sisyphus) MUST be invoked via their context: fork skill, not via Agent().
</delegation_rules>

<model_routing>
Override model: `Agent(subagent_type="oh-my-claudeagent:NAME", model="haiku|opus")`

Override effort: `Agent(subagent_type="oh-my-claudeagent:NAME", effort="max|high|medium|low")` — controls thinking token budget. The `effort` field is also declarable in agent and skill frontmatter as a default.
</model_routing>

## Skills

Invoke via `/oh-my-claudeagent:NAME` or keyword triggers (quoted phrases auto-detected by hooks).

| Skill | Invoke | Purpose |
|-------|--------|---------|
| ralph | "ralph", "don't stop" | Persistence loop until verified complete |
| ultrawork | "ulw", "ultrawork" | Maximum parallel execution |
| atlas | "run atlas", `/atlas` | Execute work plans via Atlas orchestrator |
| prometheus-plan | "create plan", `/prometheus-plan` | Strategic planning via Prometheus |
| start-work | `/start-work` | Execute from a generated plan |
| handoff | "handoff" | Session continuity summary |
| cancel-ralph | "cancel ralph" | Cancel active ralph persistence loop |
| stop-continuation | "stop continuation" | Stop all continuation mechanisms |
| consolidate-memory | `/consolidate-memory` | Consolidate and deduplicate agent memory files |

## Bundled Tools

This plugin bundles three MCP servers via `.mcp.json`:

**omca** — Structural code search (ast-grep), boulder/evidence/notepad state, and concurrency tools.

**grep.app** — Public GitHub repository code search (via Vercel): ~1M public repos with language, repository, and file path filters.

**context7** — Library documentation lookup (via context7.com): resolve library ID first, then query docs.

Notepad sections per plan: `learnings`, `issues`, `decisions`, `problems`, `questions`. Always append, never overwrite.

<tool_routing>
**Search**: Use `ast_search` for structural code patterns; `Grep` for text/string search; `ast_find_rule` for YAML combinator queries. Use `grep.app` MCP tools for real-world usage examples across public GitHub repos; use local `Grep` or `ast_search` for the current project.

**Library documentation**: Use `context7` MCP tools — resolve library ID first, then query docs. Prefer context7 over WebFetch for well-known libraries; fall back to WebFetch/librarian for niche or recent libraries.

**Verification workflow**: After running any build, test, or lint command, call `evidence_log(evidence_type, command, exit_code, output_snippet)` to create `.omca/state/verification-evidence.json`. The `task-completed-verify` hook BLOCKS task completion if this file is missing or stale (>5 min). Example:
`evidence_log(evidence_type="test", command="npm test", exit_code=0, output_snippet="42 tests passed")`

**Boulder lifecycle**: When starting plan execution, call `boulder_write(active_plan, plan_name, session_id)` to register the active plan. Use `boulder_progress` to check completed vs remaining tasks. Hooks and subagents discover the active plan via `mode_read`.

**Project rules**: `.omca/rules/*.md` files with `# pattern: <glob>` headers auto-inject when matching files are read or edited. Check for injected `[Rule: ...]` context and follow project-specific conventions.
</tool_routing>

<execution_protocols>
- Broad or ambiguous requests: explore first (discover scope), then plan (design approach), then execute (implement).
- Two or more independent tasks should run in parallel — use multiple `Agent()` calls in a single response, up to 5 concurrent agents.
- Exploration agents (explore, librarian): ALWAYS use `run_in_background=true` when you have other independent work to do. Example: `Agent(subagent_type="oh-my-claudeagent:explore", prompt="...", run_in_background=true)`
- Before concluding: ensure zero pending tasks, tests passing, and evidence collected for any claims made.
- Subagents without AskUserQuestion write questions to notepad questions section via notepad_write(plan_name, "questions", ...) and return. Orchestrators check notepad after each delegation and relay questions to the user.
- Once you delegate exploration to explore/librarian, do NOT manually re-search the same information. Continue only with non-overlapping work.
</execution_protocols>

<verification>
Verify outcomes when the task involves running code, deploying, modifying build config, or claiming test results.

| Claim | Required Evidence |
|-------|-------------------|
| "Tests pass" | Test runner output showing all pass |
| "Build succeeds" | Build command output with zero errors |
| "Bug fixed" | Before/after demonstration or test |
| "Feature works" | Running code or test output |
| "Refactor complete" | Tests still pass, no regressions |
</verification>

<workflow_modes>
Planning pipeline: prometheus (plan) → metis (gap analysis) → momus (review) → atlas (execute all tasks).

Execution entry point: After plan approval, run `/oh-my-claudeagent:start-work` (handles plan discovery, boulder setup, worktree) or `/oh-my-claudeagent:atlas [plan path]` (direct atlas execution). Both fork atlas at depth 0. The main session agent must NEVER implement plan tasks directly.
</workflow_modes>

<hooks_and_context>
Hooks inject context via `<system-reminder>` tags. Key patterns:
- `hook success: Success` — proceed normally
- `hook additional context: ...` — read it, relevant to your task
- `[NAME DETECTED]` — a keyword trigger activated a skill or mode

Runtime state lives in `.omca/` (gitignored): state in `.omca/state/`, plans in `.omca/plans/`, logs in `.omca/logs/`.
</hooks_and_context>

<rules>
NEVER:
- Exceed 5 concurrent agents
- Write state to `~/.claude/` — use `.omca/state/` instead
- Use `Bash(claude ...)` or any CLI binary to spawn agents — ALWAYS use the native `Agent(subagent_type=...)` tool
- Spawn orchestrators (atlas, sisyphus) via `Agent()` — invoke them via their `/oh-my-claudeagent:NAME` skill instead
</rules>

## Setup

Run `/oh-my-claudeagent:omca-setup` to configure or update.
Run `/oh-my-claudeagent:omca-setup --uninstall` to remove.

--- /omca-setup ---
