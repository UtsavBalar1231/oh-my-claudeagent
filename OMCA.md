# oh-my-claudeagent — Complete Guide

Plugin for Claude Code adding multi-agent orchestration: specialist agents, slash-command/keyword skills, hook-driven persistence, MCP servers for structural search and state tracking.

Install: `README.md`. Contributor internals: `CLAUDE.md`.

## Where To Look

| You want to... | Go to |
|---|---|
| Know what this is, new to the project | `README.md` |
| Install the plugin | `README.md` install section |
| Configure a setting, env var, or hook toggle | `docs/reference/configuration.md` |
| Something is broken or behaving unexpectedly | `docs/reference/known-issues.md` |
| Contribute code, add a hook or agent | `docs/CONTRIBUTING.md` |
| Understand agents, skills, MCP tools, runtime state | this file, sections below |

---

## What Is This

Claude Code runs single-threaded. Simultaneous research + implementation, or ten files needing fixes at once, bottleneck the default session. No built-in specialist delegation or persistence guarantee.

OMCA adds a multi-agent layer: specialist agents on two model tiers (opus for the roster, fable for oracle) tuned by per-agent effort, skills via slash commands or keywords, hooks for persistence and context injection, MCP servers for structural search and state.

### Philosophy

Delegate to specialists, verify with evidence, ship with confidence. Core loop: explore → plan → execute in parallel → verify. Every agent delegates or implements — never both. Every claim requires evidence.

---

## Ownership Model

**Claude-native**: plan mode, memory, hooks, plugin schema, permissions, sandboxing, subagents, teams, `claude agents` agent view (Research Preview, v2.1.139+), `/goal` completion-condition loop (v2.1.139+).

**OMCA**: agent prompts, orchestration policy, skill prompts, keyword activation, evidence discipline (one completeness check), `omca` MCP server (ast tools, boulder, evidence, notepad, file_read), stateless guardrail hooks, execution metadata in `.omca/state/` and `.omca/logs/`.

Claude-native plans are canonical. The plans directory is the `plansDirectory` setting when set (a path relative to the project root), otherwise `~/.claude/plans`; an active plan-mode file path overrides both. Every OMCA surface that authors or discovers a plan resolves that directory rather than hardcoding it. `.omca/plans/` remains a supported compatibility mirror/resume surface maintained by boulder, not the primary authored plan surface.

**`/goal` vs `/oh-my-claudeagent:start-work`**: `/goal` is a native completion-condition loop. `/start-work` pairs with boulder state and evidence gating for plan-driven work. For timer-based re-runs, use native `/loop` — it is not a verified persistence loop, but it is the lightest way to keep running until you manually stop.

**`/fork`, `/subtask`, `/tasks`, `/doctor`, `/code-review`, `/deep-research`** are all Claude-native. `/fork` opens a background session; `/subtask` is the in-session subagent, user-driven and untracked by boulder or evidence, unlike an `Agent()` delegation. Neither is the skill-frontmatter `context: fork`, which forks a fresh agent context for a skill body. `/tasks` is the native shared task list for in-session teammate coordination; boulder owns cross-session plan binding plus the sha256 and evidence gating, which is why the two are not the same board. `/doctor` (alias `/checkup`) is fix-capable; `/oh-my-claudeagent:omca-setup --doctor` is read-only and OMCA-scoped. `/code-review` owns diff review and `/deep-research` owns per-claim cross-checking; `oracle` and `librarian` keep depth review and version-matched library lookup respectively.

**Channels**: Not used — OMCA focuses on in-session orchestration via hooks, subagents, skills.

---

## Core Concepts

### Agents

Markdown files in `agents/*.md` with YAML frontmatter (name, model, disallowedTools, behavior). Addressable via `Agent(subagent_type="oh-my-claudeagent:NAME")`.

**Model tiers:**

| Tier | Default for | Use for |
|------|-------------|---------|
| fable | oracle | Hardest reasoning, stuck debugging, long-horizon work; heavy and slow, read-only advisor only |
| opus | Every other agent: orchestrator, planners, reviewers, executor, searchers, fixer, visual analysis | Everything else the plugin spawns, from a scoped lookup to architecture |
| sonnet | (override only) | Still a valid `Agent(..., model="sonnet")` override; no agent declares it |
| haiku | (override only, outdated) | Quick lookups, simple transforms; still supported, just off the default roster |

**The model column no longer tells the agents apart.** With one tier covering everything but
oracle, `model:` cannot distinguish a searcher from a planner. `effort:` is what does, and every
agent declares it in frontmatter:

| Effort | Agents | Why that level |
|--------|--------|----------------|
| low | explore | Short, scoped work that is not intelligence-sensitive, which is what the docs reserve `low` for (`claude-code-docs/docs/model-config.md`, "Choose an effort level") |
| medium | executor, hephaestus, librarian, multimodal-looker | Same source: `medium` reduces token usage for cost-sensitive work that can trade off some intelligence. These four run most often, so per-call spend matters more here than reasoning depth |
| xhigh | sisyphus, prometheus, metis, momus | Deeper reasoning at higher token spend, for orchestration, interviewing, gap analysis, and plan review |
| max | oracle | Deepest reasoning, for the one role that is only asked when something is already stuck |

So scaling a delegation up or down means picking the agent whose declared effort fits, or
overriding effort, not picking a different model. `agents/sisyphus.md`'s Model Routing section
carries the same rule for call sites: pass no `model=` at all in the usual case.

The same collapse reaches `servers/categories.json`. Four of its five categories (`quick`,
`standard`, `deep`, `readonly`) now name `opus` and only `hardest` names `fable`, so a consumer
reading `.value.model` sees two distinct outcomes across five categories. What actually separates
those categories is effort, and the category schema has no field for it, so the file's
distinctions are narrower than its category names suggest.

Override any agent's model: `Agent(subagent_type="oh-my-claudeagent:explore", model="haiku")`

**Delegation chain:** Depth 1 subagents cannot spawn further subagents — `Agent` tool stripped.

```
main session (sisyphus identity, depth 0, full Agent tool)
  -> worker (depth 1, via Agent() — terminal)
```

The orchestrator (`sisyphus`) is the main-session identity injected via
`templates/claudemd.md`. Plan-driven execution is triggered via
`/oh-my-claudeagent:start-work` — a slash command that runs inline in the main session
at depth 0 with full Agent-tool access (its body carries the Plan Execution Mode
protocol). No `context: fork` skill intermediates between user and orchestrator.

**Permission inheritance:** Plugin subagents inherit the parent session's permission mode,
including auto mode. `permissionMode` in agent frontmatter is stripped by Claude Code for
plugin agents. To retain `permissionMode`, copy agent files to `~/.claude/agents/`
(user-scope agents retain it).

**`initialPrompt` in agent frontmatter (v2.1.141–v2.1.167, not adopted):**

Agent files can declare an `initialPrompt:` field that fires an unconditional model turn
at session start, before any user message. OMCA does not adopt this because
`scripts/subagent-start.sh` already injects boulder plan context and mode banners as
`additionalContext` on `SubagentStart` — the same information at zero model-turn cost.
Adding an `initialPrompt` would consume a billable turn per subagent instantiation with
no new information benefit.

**Plugin-agent frontmatter restrictions (v2.1.154+):** Claude Code silently ignores
`hooks`, `mcpServers`, and `permissionMode` in agent frontmatter for plugin-shipped
agents (i.e., agents in the plugin's `agents/` directory). No OMCA agent currently
declares any of these fields. If you need an agent that uses custom hooks, extra MCP
servers, or a specific permission mode, copy that agent file to `~/.claude/agents/`
(user-scope) or `.claude/agents/` (project-scope) — agents at those paths are not
plugin-managed and have no frontmatter restrictions.

**Lean system prompt default (v2.1.154):**

New subagents receive a shorter system prompt by default. Agents with detailed
instructions in their frontmatter `description:` / body are unaffected. OMCA agent
definitions are self-contained and already carry their full instruction sets.

**`subagent_type` matching (v2.1.140):**

`Agent(subagent_type=...)` matching is case- and separator-insensitive as of v2.1.140.
`"oh-my-claudeagent:executor"`, `"oh-my-claudeagent:Executor"`, and
`"oh-my-claudeagent_executor"` all resolve to the same agent. OMCA uses consistent
lowercase colon-separated names throughout; this change is backward-compatible.

**Inline agent `mcpServers` — strict-mcp policy (v2.1.153):**

For inline agents that declare `mcpServers` in their frontmatter, Claude Code now
enforces the session's strict-mcp policy (e.g., `allowManagedMcpServersOnly`). No OMCA
agent declares `mcpServers` frontmatter (confirmed by grep); this change has no
behavioral impact on OMCA.

**Multiple `Agent(...)` types in `tools:` frontmatter (v2.1.147):**

A platform bug was fixed in v2.1.147 where listing multiple agent types in a skill's
`tools:` frontmatter would cause only the first to be recognized. OMCA skills that
declare `tools: [Agent(...)]` are unaffected — no OMCA skill lists multiple Agent types.

**Model resolution order:** `CLAUDE_CODE_SUBAGENT_MODEL` env > per-invocation model >
agent frontmatter model > main session. Warning: setting `CLAUDE_CODE_SUBAGENT_MODEL`
globally overrides all agent model tiers.

### Skills

Skills are directories in `skills/*/SKILL.md`. They can be invoked two ways:

- **Slash commands:** `/oh-my-claudeagent:NAME` in any Claude Code session
- **Keywords:** Natural phrases typed in any prompt auto-activate certain skills

Skills support a `paths:` frontmatter field with glob patterns for file-specific
auto-activation (e.g., `paths: ["**/*.tsx"]` activates a skill when matching files are
opened).

Two execution modes:

- **Direct skills** — the SKILL.md IS the agent prompt, runs in the current session
- **`context: fork` skills** — forks into a fresh agent context. OMCA's fork skills set
  `background: false`, which keeps the result inline in the invoking turn and preserves the
  full tool set; a backgrounded fork gets the narrower background-subagent tool set and its
  result arrives a turn later

Two frontmatter fields govern that:

| Field | Effect |
|-------|--------|
| `background` | Only meaningful with `context: fork`. `false` waits for the fork's result in the invoking turn. Default is `true` as of v2.1.218, so OMCA's fork skills declare `false` explicitly |
| `disable-model-invocation` | Blocks model auto-load and subagent preloading, so the skill runs only when a user types its slash command. Set on `handoff` |

Keywords are the natural interaction model. Type "create plan" or "fix build" in any prompt and the corresponding skill activates automatically. Slash commands are also available for explicit invocation.

**`disallowed-tools` frontmatter (v2.1.152):**

SKILL.md files can declare a `disallowed-tools:` list in their frontmatter to prevent
specific tools from being available when the skill runs. OMCA adopts this on the skills below:

| Skill | disallowed-tools | Reason |
|-------|-----------------|--------|
| `github-triage` | `[Write, Edit]` | Orchestrator skill is read-only; reports are written by spawned executor subagents |
| `hephaestus` | `[Agent]` | Forked specialist must not delegate; fix loop is solo |

For `context: fork` skills bound to a named agent via `agent:` frontmatter (e.g., metis,
momus), skill-level `disallowed-tools` is redundant — the agent definition already
enforces `disallowedTools` at the agent-config layer. The skill layer only matters for
skills running in the main session without an `agent:` binding.

**`arguments:` frontmatter (v2.1.141–v2.1.167, not adopted):**

Skills can declare an `arguments:` block in their frontmatter to name positional parameters
that the platform binds when the skill is invoked as a slash command with trailing text
(e.g., `/oh-my-claudeagent:plan fix the auth bug` → `$task="fix"`). OMCA does not adopt
`arguments:` because shell-style positional binding truncates free-form input: only the
first token is bound, making it unsuitable for narrative task descriptions. OMCA skill
bodies receive the full user prompt via the platform's natural expansion path instead.

**`hooks:` frontmatter (v2.1.141–v2.1.167, not adopted):**

SKILL.md files can declare a `hooks:` block to register hook handlers that are active
only while the skill is running. OMCA does not adopt this because hooks declared in
skill frontmatter are invisible to `scripts/validate-plugin.sh`, which validates hooks
only from `hooks/hooks.json`. All OMCA hook registration stays in `hooks/hooks.json`.

**`skillOverrides`, `skillListingBudgetFraction`, `maxSkillDescriptionChars` settings (v2.1.141–v2.1.167, not adopted):**

These are user-preference settings in `settings.json`:
- `skillOverrides` — per-skill invocation-mode overrides (e.g., `"user-invocable-only"`). Does **not** apply to plugin-shipped skills; only affects user-scope and project-scope skills.
- `skillListingBudgetFraction` — fraction of context budget allocated to skill listing.
- `maxSkillDescriptionChars` — cap on characters shown per skill description in listings.
- `skillListingMaxDescChars` — the successor key. It makes the 1,536-character description
  cap a settable default rather than a fixed platform limit. OMCA's own thresholds need no
  change, since the 512-character soft cap keeps every description far below either number.

OMCA does not adopt any of them. The plugin controls its own skill descriptions and invocation contracts; user-side `skillOverrides` has no effect on plugin skills and cannot be used to restrict or redirect them.

**`\$` escape syntax (v2.1.163):**

In SKILL.md bodies, `\$` is now a documented escape for a literal dollar sign (prevents
variable interpolation by the platform). OMCA has zero literal dollar-digit sequences in
command/skill bodies; no existing files need updating.

**`/reload-skills` command (v2.1.152):**

The platform adds a `/reload-skills` command that reloads skill definitions from disk
without restarting the session. Useful after editing a SKILL.md mid-session. OMCA has no
handler for this — it fires as a slash-command expansion, not a hook event.

**Platform `workflow` keyword renamed `ultracode` (v2.1.157):**

The platform's built-in dynamic-workflow keyword was renamed from `workflow` to
`ultracode` in v2.1.157. OMCA does not reference the platform keyword;
no OMCA files are affected.

### Hooks

Hooks are bash scripts in `scripts/*.sh`, registered in `hooks/hooks.json`. They run on
Claude Code lifecycle events and provide:

- Context injection (AGENTS.md, rules, notepad directives)
- Permission auto-approval for known-safe package managers (npm, yarn, pnpm, bun), jq, and uv run/sync. Blocks destructive patterns (rm -rf).
- Error recovery suggestions (re-read after failed Edit, escalate after failed Agent)
- Compaction survival (state saved pre-compact, re-injected post-compact)
- Verification gating (TaskCompleted blocked without fresh evidence)

**Hook events OMCA handles:**

This table is the documented mirror of `jq -r '.hooks | keys[]' hooks/hooks.json`, and
`scripts/validate-plugin.sh` fails if the two disagree in either direction. Add an event
row only when a handler is actually registered for it.

| Event | Category |
|-------|----------|
| `SessionStart` | Lifecycle |
| `UserPromptSubmit` | Lifecycle |
| `UserPromptExpansion` | Lifecycle |
| `SubagentStart` | Lifecycle |
| `SubagentStop` | Lifecycle |
| `PreToolUse` | Tool lifecycle |
| `PermissionRequest` | Tool lifecycle |
| `PermissionDenied` | Tool lifecycle |
| `PostToolUse` | Tool lifecycle |
| `PostToolUseFailure` | Tool lifecycle |
| `Stop` | Lifecycle |
| `TaskCompleted` | Task lifecycle |
| `PreCompact` | Memory |
| `SessionEnd` | Lifecycle |

`PermissionDenied` routes to `permission-denied-coach.sh`, which turns an auto-mode
classifier denial into retry guidance. `UserPromptExpansion` routes to
`slash-command-mode-detector.sh`.

**Registered platform events OMCA does not handle:**

| Event | Why no handler |
|-------|----------------|
| `PostCompact` | Compaction re-injection runs on `SessionStart` with reason `compact` instead, which is where the restored context can still reach the model. `compact_summary` is genuinely uncaptured but has no consumer |
| `StopFailure` | Fires on API errors and cannot block. Its `error` class is uncaptured; recovery is a manual `/oh-my-claudeagent:start-work` re-run, which needs no hook |
| `Notification` | Desktop notification delivery was removed in the v2.10 minimize-to-core refactor; hooks also no longer have terminal access |
| `ConfigChange`, `CwdChanged`, `FileChanged` | Observability-only in OMCA's prior handlers, removed in the same refactor. Re-evaluating `FileChanged` also reopens `SessionStart` `watchPaths` |
| `WorktreeCreate`, `WorktreeRemove` | Worktree isolation policy is Claude-native's. `--worktree` delegation is prompt-injected paths plus boulder bookkeeping, so there is nothing for a worktree hook to add |
| `InstructionsLoaded` | Async and observability-only: no injection capability, and it reports `CLAUDE.md` / `.claude/rules` loads rather than `.omca/rules`, so it cannot replace `context-injector.sh`'s content-hash ledger |
| `TaskCreated`, `TeammateIdle` | Task-collaboration lifecycle owned by the native shared task list. Only `TaskCompleted` is registered among the three, as the evidence gate |

**New platform events (v2.1.141–v2.1.167):**

| Event | Added | Status | Notes |
|-------|-------|--------|-------|
| `MessageDisplay` | v2.1.152 | Not adopted | Display-only terminal overlay; `displayContent` never reaches the transcript or context. Re-confirmed not-adopted 2026-07-01: screen/transcript divergence conflicts with evidence-first design, and every candidate use serves better via durable `additionalContext`/evidence |
| `PostToolBatch` | v2.1.152 | Not adopted (removed) | Still a valid platform event in v2.1.197; OMCA's handler was removed in the v2.10 minimize-to-core refactor — see footnote below |
| `Elicitation` | v2.1.152 | Not adopted | Fires when the model issues an elicitation request |
| `ElicitationResult` | v2.1.152 | Not adopted | Fires with the elicitation response |
| `Setup` | v2.1.152 | Not adopted | Plugin initialization event |
| `DirectoryAdded` | v2.1.219 | Not adopted (PROVISIONAL) | Tracked only. The event exists as a changelog line with no section, no matcher table, and no input schema in the hooks reference, so a handler would be built on a guessed payload |

The table heading's version range covers the first five rows; `DirectoryAdded` postdates it
and is dated in its own row.

The non-adopted events are tracked in `validate-plugin.sh`'s `new_platform_events` array. The validator skips them when no handler is present and
passes when one is present — no failures on absence.

**PostToolBatch history:** implemented in v2.7.0 as `scripts/post-tool-batch.sh`
(same-file parallel-edit warnings, batch-consolidated delegation reminder, and the
`agent-usage-reminder.sh` per-call-to-per-batch migration); removed in the v2.10
minimize-to-core refactor along with `agent-usage-reminder.sh` — neither script exists
in the current tree.

**Stop / SubagentStop — new input fields (v2.1.145):**

The Stop and SubagentStop hook payloads now include two additional fields:

| Field | Type | Notes |
|-------|------|-------|
| `background_tasks` | array | Platform-managed background tasks running at Stop time |
| `session_crons` | array | Scheduled cron jobs registered for the session |

OMCA's Stop hook (`final-verification-evidence.sh`) does not consult these fields — it checks only boulder state and evidence. Background tasks are orthogonal to the completeness check. (Verified by test: the v2.1.145 Stop payload change has zero behavioral impact on OMCA hooks.)

**Stop / SubagentStop — `additionalContext` output (v2.1.163):**

Partially adopted. All three Stop hooks (`plan-continuation-guard.sh`,
`final-verification-evidence.sh`, `drift-guard.sh`) now block by writing Stop
decision-control JSON to stdout and exiting 0, instead of writing to stderr and exiting 2.
What they emit is `decision: block` plus `reason`, and nothing else.

`additionalContext` is **not** emitted alongside it. The Stop decision-control section of
`claude-code-docs/docs/hooks.md` presents `hookSpecificOutput.additionalContext` as the
alternative to blocking, for non-error feedback that keeps the conversation going, and its
`decision: block` example carries no `additionalContext` field. Nothing in the docs states
that the two combine, and how a block presents in the transcript when both are emitted is
unverified. Emitting both would also deliver the same text twice, so the blocking pair alone
is what `block_exit()` in `scripts/lib/common.sh` writes.

Among the turn-gate and task-gate hooks, `task-completed-verify.sh` is now the only one that
blocks via exit 2. Exit 2 remains the correct block shape for the PreToolUse and
PermissionRequest deny hooks, and `git-destructive-deny.sh`, `sed-grep-deny.sh`, and
`executor-grep-deny.sh` still use it, writing to stderr only.

**SessionStart — new output fields (v2.1.152):**

`SessionStart` hooks can return two new fields:

| Field | Adopted by OMCA | Notes |
|-------|----------------|-------|
| `sessionTitle` | Yes — `session-init.sh` emits `"OMCA: <plan_name>"` when boulder is active | Sets the session title in the platform UI |
| `reloadSkills` | No | Boolean; forces a skill reload on session start — no OMCA use case |

**Stop hook block cap (v2.1.143):**

The platform enforces a maximum of 8 consecutive Stop blocks per session. The cap is
configurable via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (env var). OMCA's Stop hook
(`final-verification-evidence.sh`) does not block the Stop event unless the plan
is complete but evidence is missing — it never emits a persistence-style block.
(Adopted in the v2.1.141–v2.1.167 sync.)

**`SessionStart` `watchPaths` output (v2.1.141–v2.1.167, not adopted):**

`SessionStart` hooks can return a `watchPaths` array to register file-system paths for
`FileChanged` event delivery. OMCA does not adopt this: there is no `FileChanged`
handler in the current tree (the prior side-effects-only handler was removed in the
v2.10 minimize-to-core refactor along with `CwdChanged`/`FileChanged` registration), and
no runtime reader that would benefit from expanded watch coverage. Extending the watch
set would generate noise without actionable signal.

**`PostToolUse` `updatedToolOutput` field (v2.1.141–v2.1.167, not adopted):**

`PostToolUse` hooks can return `updatedToolOutput` to rewrite the tool result visible to
the model. OMCA deliberately does not adopt this. Rewriting tool output post-hoc is
adversarial to evidence integrity — OMCA's verification model depends on the model seeing
the literal command output, not a hook-filtered version. All context augmentation is done
via `additionalContext`, which appends without overwriting.

**Hooks run without terminal access (v2.1.141+):**

Hook scripts no longer have access to `/dev/tty` or terminal control sequences. OMCA
has no desktop-notification handler in the current tree (the prior `notify.sh` script,
which used only `terminal-notifier`, `osascript`, `notify-send`, `zenity`, `powershell`,
and stderr bell, was removed in the v2.10 minimize-to-core refactor); this platform
change has no OMCA impact.

Hooks can now emit a `terminalSequence` output field to inject terminal escape sequences:
```json
{"hookSpecificOutput": {"hookEventName": "EVENT", "terminalSequence": "[2J"}}
```
OMCA does not use `terminalSequence` — existing desktop-notification paths remain unchanged.

**`if:` condition matching semantics (v2.1.163):**

The `if:` field on hook handlers updated its matching semantics in v2.1.163. OMCA's
12 `if:` clauses are all command-name-only globs (e.g., `Bash(rm *)`, `Bash(npm *)`) and
are unaffected — the update only changes behavior for patterns that use subshell or
backtick constructs, which OMCA does not.

Hook handlers support an `if` field using permission rule syntax (e.g., `Bash(git *)`)
for argument-level filtering on tool events (`PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`). Reduces process spawning overhead.

Hooks communicate via stdout JSON:
```json
{"hookSpecificOutput": {"hookEventName": "EVENT", "additionalContext": "..."}}
{"hookSpecificOutput": {"hookEventName": "Stop", "decision": {"behavior": "block"}}}
```

### bin/

Added in v2.1.91 (changelog.md:895). Plugins can ship executable scripts or binaries under a `bin/` directory at the plugin root. Claude Code prepends that directory to the Bash tool's `PATH` for the duration of the session, so any executable placed there is available as a bare command without specifying a full path. Files must have the executable bit set (`chmod +x`) and a `#!/usr/bin/env bash` (or equivalent) shebang.

OMCA ships:
- `bin/omca-status` — print active boulder, evidence summary, and plan completion status
- `bin/omca-doctor` — read-only health check (dependencies, settings, state directories, MCP server)

Both scripts are invokable from any Bash tool call as bare commands: `omca-status` and `omca-doctor`. They read the project's `.omca/state/` and `~/.claude/settings.json` only, and never mutate state.

Plugin-root `settings.json` ships a `subagentStatusLine` default backed by `bin/omca-subagent-statusline`. Users can override per-project by setting their own `subagentStatusLine` in `~/.claude/settings.json` or a project-level settings file. Omitting all overrides falls back to the platform's default `name · description · token count` row.

**`statusLine.refreshInterval` (v2.7.0, ADOPTED):**

`omca-setup` Phase 5.6 sets `statusLine.refreshInterval: 5` (seconds) in `~/.claude/settings.json` alongside `hideVimModeIndicator`. This is the recommended value for OMCA: the statusline reads disk-cached git metadata (branch, PR state) that updates on roughly a 5 s cadence, so a matching refresh interval keeps the display current without polling faster than the cache. In background-agent idle scenarios — where the model is waiting on a subagent and no tool calls are firing — the platform only refreshes the statusline at this interval, so a value below 5 yields no additional freshness from the disk-cached sources. Doc-claim ceiling: the freshness improvement is specific to disk-sourced fields (`workspace.repo.*`, `pr.*`); fields sourced directly from the active tool call context update on each render regardless of this setting.

**Statusline platform additions (v2.1.141–v2.1.167):**

New fields added to the statusline input JSON payload, adopted in `statusline/core.py`:

| Field | Version | Adopted | Notes |
|-------|---------|---------|-------|
| `workspace.repo.{host,owner,name}` | v2.1.145 | Yes | Repo identity segment; OSC 8 link to `https://{host}/{owner}/{name}` when all three present |
| `pr.{number,url,review_state}` | v2.1.145 | Yes | PR number (#N) with optional OSC 8 link; review_state → glyph (approved=+/green, changes_requested=!/red, pending=?/yellow, draft=d/dim) |
| `COLUMNS` / `LINES` env vars | v2.1.153 | Yes — `COLUMNS` fallback in `bin/omca-subagent-statusline` | Payload `columns` still wins; env vars complement when payload absent |
| `context_window.remaining_percentage` | v2.1.153 | Yes — `_render_context_bar` uses it when `pct` arg is None | Falls back to `current_usage` calculation; explicit `pct` still wins |
| per-task `effort` (`subagentStatusLine`) | v2.1.214 | Yes, `statusline/subagent.py` renders it per row | **Different shape from the main line.** Here it is a bare string or int, not the main line's `{"level": ...}` dict, so the main-line read cannot be copied. Absent means the subagent inherited the session level, and absence renders nothing |
| `contextWindowSize` (`subagentStatusLine`) | v2.1.205 | Yes, the row renders `N% ctx` when it is a positive int | Falls back to the raw `N.Nk tok` form when the field is absent, so tasks on different window sizes stay comparable when the platform supplies it |

Main-line `effort.level` uses the platform enum `low`/`medium`/`high`/`xhigh`/`max`. `high`
is the default and `medium` is an explicitly lowered level, so no value is safe to suppress
as noise; `"normal"` is not a platform value at all. Unknown levels pass through unchanged.

Fast mode has no documented statusline field. `fastMode` and `fastModePerSessionOptIn` are
documented as settings keys only, and no retrieved platform doc lists a fast-mode key in
either the `statusLine` payload or the `subagentStatusLine` per-task object. It is
deliberately unimplemented rather than inferred, since a guessed key would render nothing
forever while reading as adopted. Settling it needs an observed payload, not a guess: the
field name, its shape, and which payload carries it are all unknown, and `effort` is the
cautionary case, since the main line carries `{"level": ...}` while the per-task field is a
bare string or int.

`OMCA_SUBAGENT_STATUSLINE_DUMP` captures the raw per-task payload for that purpose and for
any future subagent-row field work. Diff the payload key sets between a capture taken with
the feature off and one taken with it on, then confirm whether the key is absent or merely
falsy in the off state, since those need different render guards. See `statusline/README.md`
for the env-var table.

### plugin.json

OMCA's `plugin.json` is the plugin manifest. Key fields and recent platform additions:

**`displayName` (v2.1.143, ADOPTED):**

A human-readable display name shown in the plugin marketplace and `/plugin list` output.
OMCA sets `displayName` in `plugin.json`. Added during v2.1.141–v2.1.167 sync.

**`defaultEnabled` (v2.1.154, NOT adopted):**

Setting `"defaultEnabled": false` keeps a plugin installed but inactive until explicitly
enabled. OMCA deliberately leaves this field absent (defaults to `true`) — OMCA is
designed to be active immediately on install; an inactive-by-default state would break
the first-session experience.

**Root-level `SKILL.md` for single-skill plugins (v2.1.142):**

Plugins that ship exactly one skill can place `SKILL.md` at the plugin root (instead of
`skills/<name>/SKILL.md`). OMCA ships many skills and continues using the subdirectory
layout; the root-level shorthand is not applicable.

**Dependency enforcement on disable (v2.1.143):**

When a plugin is disabled, Claude Code now checks whether other enabled plugins declare
it as a dependency and blocks the disable if so. OMCA has no declared dependents in
OMCA's known marketplace installations; this mechanism does not affect OMCA's install or
disable behavior.

### Monitors

Added in v2.1.105 (changelog.md:640). Since v2.1.129 they must live under `"experimental": {}` in `plugin.json` or `claude plugin validate` will warn. Monitors are background processes defined in `monitors/monitors.json` that Claude Code starts automatically when the plugin is active. Each monitor entry specifies a `name`, a long-running `command` (e.g. `tail -F ./logs/error.log`), and an optional `description`; each stdout line is delivered to Claude as a notification during the session.

OMCA does not currently adopt monitors — the hook-based context injection model covers all current context-delivery needs. The mechanism is documented here for future evaluation if real-time file-watch or external-event delivery is needed.

```json
// monitors/monitors.json (example — not currently used by OMCA)
[
  {
    "name": "error-log",
    "command": "tail -F ./logs/error.log",
    "description": "Application error log"
  }
]
```

---

## Getting Started

### Installation

From the command line:

```bash
claude plugin marketplace add UtsavBalar1231/oh-my-claudeagent
claude plugin install oh-my-claudeagent@omca
```

Or from inside a Claude Code session:

```
/plugin marketplace add UtsavBalar1231/oh-my-claudeagent
/plugin install oh-my-claudeagent@omca
```

### Setup

After installing, run `/oh-my-claudeagent:omca-setup`. This checks dependencies (`jq`,
`uv`, `python3` 3.10+), injects the orchestration block into `~/.claude/CLAUDE.md`,
offers to apply permission rules, and prints a health report. Use `--check` for read-only
health check, `--uninstall` to remove.

### Plugin lifecycle commands

| Command | Use case |
|---|---|
| `claude plugin install <name>` | Install a plugin from a known marketplace |
| `claude plugin details <name>` | (v2.1.139+) Show a plugin's component inventory and projected per-session token cost — useful before installing or for diffing cost across versions |
| `claude plugin list` | List installed plugins; surfaces folder-shadow warnings introduced in v2.1.140 |
| `claude plugin tag <plugin> <tag>` | Tag an installed plugin version |
| `claude plugin prune` | Remove unused cached plugin versions |
| `claude project purge` | Remove cached plugin state for the current project |
| `claude --prune` | Cascade prune: plugins + transitive dependencies |

Run `claude plugin details oh-my-claudeagent` before a major release to capture the pre-bump token-cost projection; compare against the post-bump value to spot accidental cost regressions.

### Team Setup

Add to `.claude/settings.json` for automatic team-wide installation:

```json
{
  "extraKnownMarketplaces": {
    "omca": {"source": {"source": "github", "repo": "UtsavBalar1231/oh-my-claudeagent"}}
  },
  "enabledPlugins": {"oh-my-claudeagent@omca": true}
}
```

### First Session Walkthrough

1. Install and run omca-setup
2. Start a new session: `claude`
3. Try the planning pipeline: type "create plan for adding user authentication"
   — Prometheus opens an interview, gathers requirements, generates a work plan
4. After plan review: run `/oh-my-claudeagent:start-work`
   — Sisyphus picks up the plan and delegates tasks to executor in parallel
5. For timer-based re-runs: use `/loop 10m /oh-my-claudeagent:start-work`
   — native `/loop` is a lightweight repeat, not a verified persistence loop
6. When context is long: run `/oh-my-claudeagent:handoff`
   A structured session summary is produced for pasting into a new session

---

## Agent Reference

### Orchestrator

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| sisyphus | opus | xhigh | Main session (injected via `templates/claudemd.md`) or `/oh-my-claudeagent:start-work` (Plan Execution Mode) | Master orchestrator identity — classifies requests, delegates to specialists. Two modes: free-form (conversational) and plan-driven (via `/start-work` command body). Plan Execution Mode protocol lives in `commands/start-work.md`. |

**sisyphus** — The one orchestrator. Free-form mode: routes requests to specialists, runs explore agents in background. Plan Execution Mode: reads plan, delegates per-task to `executor`, logs evidence, runs a final completeness check at the end.

### Planning and Review

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| prometheus | opus | xhigh | `/oh-my-claudeagent:plan` or "create plan" | Strategic planning with requirements interview + optional Socratic Interview Mode |
| metis | opus | xhigh | `/oh-my-claudeagent:metis` or "run metis" | Pre-planning gap analysis |
| momus | opus | xhigh | `Skill(oh-my-claudeagent:momus)` (or `Agent(subagent_type="oh-my-claudeagent:momus")` from the main session) | Rigorous plan review — OKAY or REJECT |
| oracle | fable | max | `Agent(subagent_type="oh-my-claudeagent:oracle")` | Architecture advisor, read-only |

**prometheus** — 9-item clearance checklist interview, consults metis, generates plan,
submits to momus for review (up to 3 iterations). Optional Socratic Interview Mode for
ambiguous or architectural requests: iterative dialogue, synthesis stop-criterion, does NOT
write a plan file at all (research output only).

**metis** — Classifies intent, explores codebase, identifies hidden requirements and scope
risks. Invoked automatically by prometheus.

**momus** — Evaluates plans against 5 criteria. Approval-biased for normal,
reversible plans, strict for high-risk or irreversible work.

**oracle** — Read-only. Dense output: bottom line in 2-3 sentences, action plan in 7
steps max, effort estimates (Quick/Short/Medium/Large).

### Search and Research

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| explore | opus | low | `Agent(..., run_in_background=false)` | Codebase search — files, patterns, implementations |
| librarian | opus | medium | `Agent(..., run_in_background=false)` | External docs, OSS examples, library research |

**explore** uses ast_search, Grep, Glob. Fire multiple in parallel for broad searches.

**librarian** — Uses context7 for library docs, and may create shallow read-only
dependency clones under `/tmp/opencode` for source investigation.

**Fan-out flag, not a per-agent policy.** As of v2.1.198 the platform backgrounds every
subagent unless the call passes `run_in_background=false`, so backgrounding is the default
rather than something OMCA chooses for explore and librarian. OMCA's policy is the
inverse: pass `run_in_background=false` on every fan-out call site, explore and librarian
and executor alike, because the deliverable is needed in the same turn, and a
backgrounded agent gets a narrower built-in tool set with its result arriving a turn
later. Background stays reserved for genuine meanwhile-work and for file-based-output
skills such as `github-triage`, which pins `run_in_background=true` deliberately. The
invariant that made this policy: a background completion notification is a trigger plus an
output-file path, never the deliverable; the deliverable arrives as the `Agent` tool
result.

Socratic research interview is now part of `prometheus` (Socratic Interview Mode section).

### Execution

| Agent | Model | Effort | Invoke | Purpose |
|-------|-------|--------|--------|---------|
| executor | opus | medium | `Agent(subagent_type="oh-my-claudeagent:executor")` | Focused task executor — implements directly, never delegates implementation |
| hephaestus | opus | medium | `/oh-my-claudeagent:hephaestus` or "fix build" | Build and toolchain fixer — minimal-diff policy |
| multimodal-looker | opus | medium | `Agent(subagent_type="oh-my-claudeagent:multimodal-looker")` | Image, PDF, diagram analysis (read-only) |

**executor** implements one atomic task per delegation. It may spawn a read-only research
agent when the platform's spawn-depth ceiling allows it, and otherwise searches with
Grep/Glob/Read itself rather than reporting the task blocked. Requires fresh verification
evidence before claiming completion.

**hephaestus** — Reproduce, diagnose, fix, verify. Repeat until exit code 0. Never
refactors while fixing. Stops and escalates after 5+ failed attempts.

---

## Skill Reference

### Planning Pipeline

| Entrypoint | Surface | Invocation | Keywords |
|------------|---------|------------|----------|
| plan | command | `/oh-my-claudeagent:plan` | "create plan" |
| metis | skill | `/oh-my-claudeagent:metis` | "run metis" |
| start-work | command | `/oh-my-claudeagent:start-work` | (none) |

**start-work** — Finds the active plan (via boulder state, `.omca/plans/`, or
the resolved plans directory), sets up boulder state, optionally configures a git worktree,
then enters Plan Execution Mode in the main session (sisyphus identity) at depth 0.
The Plan Execution Mode protocol body lives in `commands/start-work.md`.

### Fixing and Development

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| hephaestus | `/oh-my-claudeagent:hephaestus` | "fix build", "build broken" |
| refactor | `/oh-my-claudeagent:refactor` | (none) |
| git-master | `/oh-my-claudeagent:git-master` | (none — invoked via `/git-master` or when Claude matches the task to the skill description) |

**refactor** — Codebase-aware refactoring: parallel analysis via 5 explore agents, codemap
and impact zone mapping, test coverage check, prometheus plan, step-by-step execution with
ast-grep, evidence-gated completion.

**git-master** — Atomic commits with style detection, rebase/squash, history search (blame,
bisect, log -S).

### Browser

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| playwright | `/oh-my-claudeagent:playwright` | (none) |
| dev-browser | `/oh-my-claudeagent:dev-browser` | "go to [url]", "take a screenshot" |

### Session Management

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| handoff | `/oh-my-claudeagent:handoff` (the only entrypoint) | "handoff", "context is getting long", "start fresh session" — advisory nudge only |

**handoff** — Gathers context from git, tasks, boulder state, and notepads, then produces
a structured HANDOFF CONTEXT block for pasting into a new session. It is user-invoked only
(`disable-model-invocation: true`), so the model cannot start it and it is not preloaded into
subagents. The keyword produces a nudge suggesting the slash command, nothing more.

### Setup and Discovery

| Skill | Slash command | Keywords |
|-------|--------------|----------|
| omca-setup | `/oh-my-claudeagent:omca-setup` | "setup omca" |
| init-deep | `/oh-my-claudeagent:init-deep` | (none) |
| frontend-ui-ux | `/oh-my-claudeagent:frontend-ui-ux` | (none) |
| github-triage | `/oh-my-claudeagent:github-triage` | (slash-command only) |
| consolidate-memory | `/oh-my-claudeagent:consolidate-memory` | (none) |

**github-triage** — Fetches open issues and PRs, classifies each, spawns one background
agent per item in parallel. Zero-action policy: never merges, closes, or edits items.

---

## Common Workflows

### Planning Pipeline

```
1. Type "create plan for [your task]"
   -> Prometheus interviews, consults metis, generates plan, runs momus review
   -> After momus approval, prometheus asks: start implementation or run metis review?

2. Run /oh-my-claudeagent:start-work (or prometheus starts it after user confirms)
   -> Finds active plan, sets up boulder state, enters Plan Execution Mode at depth 0

3. Main session (sisyphus identity) executes the Plan Execution Mode protocol:
   -> Delegates each task to executor
   -> Verifies with build/typecheck/tests after each
   -> Marks checkboxes in plan file
   -> Final completeness check via final-verification-evidence.sh

4. Resume after interruption with /oh-my-claudeagent:start-work
   -> Boulder state resumes from last completed task
```

### Session Handoff

When context is long and quality is degrading:

```
1. Run `/oh-my-claudeagent:handoff`
2. Copy the HANDOFF CONTEXT output
3. Start new session, paste context as first message
4. Continue: "Continue from the handoff context above. [Next task]"
```

---

## MCP Tools

Three MCP servers are bundled via `.mcp.json` and launched by Claude Code.

### omca (local Python MCPServer server)

Unified server for structural code search, plan tracking, verification, notepads, and filesystem access.

**AST tools** — Structural code search using ast-grep:

| Tool | Purpose |
|------|---------|
| `ast_search` | Find code patterns by structure (function signatures, class shapes) |
| `ast_replace` | Structural find-and-replace (`dry_run=true` to preview) |
| `ast_find_rule` | Advanced structural queries with YAML combinators |
| `ast_test_rule` | Test a rule pattern against a code snippet |
| `ast_dump_tree` | Dump AST of a code snippet for rule development |

**Boulder tools** — Plan tracking across sessions:

| Tool | Purpose |
|------|---------|
| `boulder_write` | Register an active work plan and accumulate session IDs across resumes |
| `boulder_progress` | Check completed vs remaining tasks for the active plan |

**Evidence tools** — Verification records:

| Tool | Purpose |
|------|---------|
| `evidence_log` | Record verification result: `evidence_log(evidence_type, command, exit_code, output_snippet)` |
| `evidence_read` | Read accumulated evidence |

**Notepad tools** — Per-plan knowledge accumulation:

| Tool | Purpose |
|------|---------|
| `notepad_write` | Append to a section: `notepad_write(plan_name, section, content)` |
| `notepad_read` | Read a section |
| `notepad_list` | List available plans and sections |

Sections: `learnings`, `issues`, `decisions`, `problems`.

**Filesystem tools** — External file access for subagents:

| Tool | Purpose |
|------|---------|
| `file_read` | Read any file with line numbers. Bypasses the Read tool's project-root scoping for subagents. Streams the requested window rather than the whole file, and cuts any single line past 2000 characters with a `... [line truncated, N more chars]` marker |
| `session_search` | Search this project's own Claude Code transcripts. Reads `<slug>/*.jsonl` and the spilled tool-result sidecars at `<slug>/<session>/tool-results/*.txt`, since a large tool output leaves only a preview in the transcript itself. Sidecar hits report role `tool` and a timestamp synthesized from file mtime, because the sidecar carries none; sources are merged newest-first by mtime. `<session>/subagents/` is deliberately out of scope: a subagent's own turns are its parent's tool result, so including them would double-count |

### grep (HTTP, via grep.app)

Public GitHub code search across approximately 1 million repositories. Use for finding
real-world usage examples, API patterns, and library implementations.

### context7 (HTTP, via context7.com)

Library documentation lookup. Two-step flow: resolve library ID first, then query docs.
Prefer context7 over WebFetch for well-known libraries.

### MCP platform additions (v2.1.141–v2.1.167)

**stdio servers receive session env vars (v2.1.154, ADOPTED):**

stdio MCP servers now receive `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE=1` in their
environment at launch. The `omca` server's `_resolve_session_id()` helper in
`servers/tools/_common.py` uses `os.environ.get("CLAUDE_CODE_SESSION_ID", "")` as a
fallback when no explicit `session_id` parameter is passed. Adopted in `boulder_write`
(v2.1.141–v2.1.167 sync).

**`dependencies` in `plugin.json` (v2.1.141–v2.1.167, not adopted):**

Plugins can declare a `dependencies` array in `plugin.json` to express inter-plugin
dependencies. Declaring a dependency causes Claude Code to block disabling a dependency
plugin while this plugin is active. OMCA has no runtime dependencies on other plugins
and does not adopt this field. No OMCA consumers exist for this schema path.

Note on marketplace tag convention: the platform marketplace uses `{plugin-name}--v{version}`
(double-dash) tag format for versioned releases (e.g., `oh-my-claudeagent--v2.6.0`),
while OMCA's own version tags follow `vX.Y.Z` (single prefix, no plugin-name prefix).
The `claude plugin install oh-my-claudeagent@omca` install path resolves via the
`omca` marketplace shortname, not a version tag, so the tag-format difference has no
practical impact on installs or upgrades.

**MCP `headersHelper` and WebSocket (`ws`) transport (v2.1.141–v2.1.167, not adopted):**

Two MCP transport additions were introduced in this window:
- `headersHelper` — a helper for injecting dynamic auth headers into HTTP-based MCP servers.
- WebSocket (`ws`) transport — an alternative connection mode alongside stdio and SSE.

Of OMCA's bundled servers, only `omca` is stdio; `grep` and `context7` declare
`"type": "http"` in `.mcp.json`. None of them needs dynamic auth headers or a WebSocket
transport, so neither feature has an OMCA consumer. The transport split does matter for
diagnostics: `claude mcp list` and `/mcp` surface HTTP status and error text for the two
HTTP servers, which is where a bad URL shows up, and hidden leading or trailing whitespace
in a configured URL reads as a URL that looks right but never connects.

**Per-server `timeout` < 1000 ms is now ignored (v2.1.162):**

Previously, a per-server timeout below 1000 ms was floored to 1000 ms. As of v2.1.162
it is silently ignored (no floor applied, no error). OMCA's `.mcp.json` has no `timeout`
keys — this change has no behavioral impact.

**Unapproved `.mcp.json` servers show "Pending approval" (v2.1.154):**

Servers listed in `.mcp.json` but not yet approved by the user now display a
"Pending approval" status indicator rather than silently failing. OMCA's bundled
servers (`omca`, `grep`, `context7`) are approved on first install; users seeing
"Pending approval" should run `/oh-my-claudeagent:omca-setup --check` to diagnose.

---

## Runtime State

All runtime state lives in `.omca/` (gitignored by default):

- `state/boulder.json` — Session-bound plan registry: one entry per plan under `plans[plan_name]`, one binding per session under `bindings[session_id]`
- `evidence/verification-evidence.json` — Verification records
- `state/active-modes.json` — Keyword detection session tracking (re-announce suppression)
- `state/compaction-context.md` — Saved state for compaction survival
- `state/injected-context-dirs.json` — Per-session dedup keys for AGENTS.md/README.md and `.omca/rules/*.md` context injection, reset every `SessionStart`
- `state/subagent-models.json` — Live subagent id → resolved model name, for the statusline renderer
- `state/notepads/{plan-name}/` — Per-plan notepad sections
- `plans/{name}.md` — Compatibility mirror/resume surface for native plans, maintained by boulder
- `logs/` — Session, edit, and subagent audit logs
- `rules/*.md` — Project rules (auto-injected on file match)

### Boulder Lifecycle

`boulder.json` is a session-bound plan **registry**, not a single-plan pointer: multiple
plans can be tracked concurrently under `plans[plan_name]`, and each session binds to
exactly one of them via `bindings[session_id]`. `servers/tools/_boulder_core.py` holds the
schema and the `resolve_bound_plan` ladder every reader calls.

1. Prometheus creates a plan at `<plans-dir>/{name}.md` or the active plan-mode file
2. `boulder_write(active_plan, plan_name, session_id)` upserts `plans[plan_name]` (preserving `started_at`, appending `session_id` to `session_ids`) and binds this session to it; `.omca/plans/` mirrors the plan for compatibility
3. `/start-work` reads `boulder_progress()` (resolves the calling session's bound plan when no explicit `plan_path`/`plan_name` is given) to resume from the last completed task
4. Sisyphus/start-work checks `boulder_progress` to track which tasks remain
5. The final-verification-evidence.sh Stop hook resolves this session's bound plan and confirms a matching `final_verification` evidence entry exists when that plan's checkboxes show it complete
6. `SessionEnd` (`session-cleanup.sh`) removes only the ending session's binding; a plan itself is never deleted while incomplete or still bound by another session. A 7-day age backstop in `boulder_write`'s `_gc_prune()` also prunes stale bindings and unbound, checkbox-complete plans, for sessions that never hit a clean `SessionEnd`

### Evidence Workflow

After every build, test, or lint command:
```
evidence_log(evidence_type="build", command="just ci", exit_code=0, output_snippet="all checks passed")
```

The `task-completed-verify` hook blocks task completion (exit 2) if evidence is stale
(> 5 minutes) and the task text implies verification was needed. Evidence gating is
keyword-aware — tasks without verification keywords (test, build, lint, verify) skip
strict evidence requirements.

### Rules

A rule file starts with a `# pattern: <glob>` first line and carries its guidance in the
body below. When a file whose **basename** matches that glob is Read, Written, or Edited,
`scripts/context-injector.sh` injects the body as additional context. One pattern per
file; the body is capped at 1000 characters, with anything past the cap replaced by a
truncation marker naming the rule's path so the full text stays one Read away.

Rules come from two directories:

- `rules/*.md` at the plugin root ships with the plugin, so every install gets it. The
  shipped set covers per-language comment conventions (Bash, Python, kernel C and headers,
  Rust, Go) and a prose convention for Markdown.
- `.omca/rules/*.md` in your project holds your own rules.

The project directory is scanned first and wins on a filename collision, so creating
`.omca/rules/comments-python.md` replaces the shipped Python rule outright. To switch a
shipped rule off rather than replace it, create a same-named file whose body is empty.
Two rules with *different* filenames both inject even when their bodies are identical,
because the injector's dedup key is the rule's resolved path.

`OMCA_DISABLED_HOOKS=context-injector` turns the whole mechanism off for a session.

---

## Keyword Activation

Mode detection is dual-path:

- **Free-text triggers** — `keyword-detector.sh` fires on `UserPromptSubmit`, pattern-matches the raw prompt text (e.g., "create plan", "fix build"), and injects context.
- **Slash-command triggers** — `slash-command-mode-detector.sh` fires on `UserPromptExpansion`, reads `command_name` directly (e.g., `oh-my-claudeagent:hephaestus`), and activates the corresponding mode without relying on the expanded body's wording. This is more reliable: mode activation works regardless of what the skill's SKILL.md body says.

Both paths share the same `active-modes.json` schema and session-aware re-announce suppression (`mode_already_announced` / `mark_mode_announced` in `scripts/lib/common.sh`). If both fire for the same mode in the same session, the second invocation suppresses silently.

The `keyword-detector.sh` hook fires on `UserPromptSubmit`, pattern-matches against
known phrases, and injects context that triggers the corresponding skill.

Keywords are the natural interaction model — type natural phrases in any prompt.

### Full Keyword Map

| Keyword / Phrase | Activates |
|------------------|-----------|
| `handoff`, `context is getting long`, `start fresh session` | an advisory nudge toward `/oh-my-claudeagent:handoff`; it does not start the workflow |
| `run metis`, `metis analyze`, `pre-plan` | metis skill |
| `run prometheus`, `create plan` | `/oh-my-claudeagent:plan` command (prometheus planning) |
| `fix build`, `build broken` | hephaestus skill |
| `setup omca` | omca-setup skill |

### @-Mention Syntax

Type `@agent-oh-my-claudeagent:<name>` to guarantee delegation to a specific agent:

```
@agent-oh-my-claudeagent:oracle what's the right architecture here?
@agent-oh-my-claudeagent:explore find all usages of the auth middleware
```

---

## Session Continuity

### Compaction Survival

When the context window fills, the plugin preserves state across compaction via two
scripts: `pre-compact.sh` (PreCompact) saves state, and `post-compact-inject.sh` fires on
`SessionStart` with reason `compact`, not on PostCompact. Active plans and task state
survive compaction. There is no `PostCompact` handler: by the time that event fires the
restored context is already assembled, so the injection has to ride the following
`SessionStart` to reach the model at all.

### StopFailure Limitation

`StopFailure` fires on API errors and cannot be blocked by a hook, and OMCA registers no
handler for it. If an API error interrupts a plan run, resume manually with
`/oh-my-claudeagent:start-work`.

---

## Troubleshooting

**MCP tools not available:** Check `ast-grep`/`sg` and `uv` are installed. Run
`/oh-my-claudeagent:omca-setup --check`. Run `/reload-plugins` to restart MCP servers.

**Subagent nesting depth:** `/oh-my-claudeagent:start-work` runs inline in the main
session at depth 0 with full `Agent`-tool access. Parallel fan-out and specialist delegation
all work. The command body in `commands/start-work.md` is the authoritative Plan Execution
Mode protocol. There is no degraded mode — orchestration only runs at depth 0 by design.
The `atlas` agent was removed in v2.0; its plan-execution protocol migrated to the command
body, its orchestrator role consolidated into `sisyphus` (the main-session identity).

**Hook changes not taking effect:** Run `/reload-plugins`.

**AskUserQuestion unavailable in subagents:** Subagents emit a `## BLOCKING QUESTIONS`
block at the end of their final response (Q1., Q2., lettered options A/B/C, Recommended:
line). The orchestrator hydrates `AskUserQuestion` via `ToolSearch`, relays, and resumes
the subagent via `SendMessage`. The platform caps each `AskUserQuestion` call at 4
questions; when a subagent raises more, the orchestrator makes multiple sequential calls
within the same turn to relay all of them.

`AskUserQuestion` no longer auto-continues when nobody answers. In `-p` or background runs
that means prometheus's interview and `plan-mode-handler.sh`'s auto-approve assumption both
stall indefinitely rather than resolving to a default. Do not build an unattended workflow
that depends on a question answering itself.

**permissionMode stripping:** Claude Code strips `permissionMode` from plugin agents.
Copy agent files to `~/.claude/agents/` (user-scope agents retain it).

**Native mode-indicator row duplicates OMCA's vim glyph:** the platform draws a
`-- INSERT --` row beneath the user's `statusLine` output. The OMCA statusline
already renders `vim.mode` on line 1, so the row is duplicate noise. Set
`statusLine.hideVimModeIndicator: true` to suppress the platform row
(documented in `https://code.claude.com/docs/en/statusline`); `omca-setup` Phase 5.6
sets this automatically on first run and back-fills it on re-run for users with
an existing `statusLine` config. Phase 5.6 also sets `statusLine.refreshInterval: 5`
alongside `hideVimModeIndicator` — see the `statusLine.refreshInterval` entry in the
`bin/` section above for the cache-TTL rationale. (Earlier versions of this document
did not mention `refreshInterval`; it was added in the 2026-06 feature sweep.)

**Permission-mode banner — no opt-out:** the `›› bypass permissions on (shift+tab
to cycle)` indicator on the same native mode-indicator row has no documented
suppression setting as of Claude Code v2.1.141. The platform renders it whenever
the active permission mode is non-`default`. The only ways to hide it are: (a)
switch the active permission mode back to `default` via `/permission-mode` (the row
now reads `Manual`, and `manual` is accepted as the mode's name in settings and on
the CLI), or
(b) wait for Anthropic to add a `hidePermissionModeIndicator` companion to the
documented `hideVimModeIndicator` field. File feedback citing the vim-indicator
precedent if this matters to your workflow.

---

## Environment Variables

Key environment variables available to hooks, skills, and Bash tool commands.

### `CLAUDE_CODE_SESSION_ID` (v2.1.132)

The current session ID is injected into the Bash tool subprocess environment, matching the `session_id` value passed to hook scripts. Hook scripts already receive `CLAUDE_SESSION_ID` via the hook payload; this variable makes the same value available to any Bash command the model runs, useful for correlating log output or scoping per-session state without requiring a hook intermediary.

### `CLAUDE_PROJECT_DIR` (v2.1.139)

Absolute path to the active project root. Hooks already received this value; v2.1.139 extends it to MCP stdio servers and to plugin command/`args:` strings, where `${CLAUDE_PROJECT_DIR}` is substituted at exec time. Use it for project-scoped paths in `.claude/settings.json` hook entries (the plugin's own hooks in `hooks/hooks.json` should keep using `${CLAUDE_PLUGIN_ROOT}`, which resolves to the installed plugin root and survives marketplace cache refreshes).

The bundled `omca` MCP stdio server inherits this variable through its environment; it reads state from `${HOOK_PROJECT_ROOT}` (set in `scripts/lib/common.sh`) rather than `${CLAUDE_PROJECT_DIR}` to preserve user overrides of the state directory. Renaming the internal variable is a separate concern with backward-compatibility implications and is not in scope here.

### `CLAUDE_EFFORT` (v2.1.133)

The active effort level (`low`, `medium`, `high`, `xhigh`, `max`) is injected into hook script environments and Bash tool subprocesses. Hook scripts can branch on effort to skip expensive operations when effort is `low`. Skills can reference `${CLAUDE_EFFORT}` in their content to communicate effort-aware instructions. Set the effort level via `/effort` or `--effort`.

### Spawn budgets

Three ceilings bound how wide and how deep a fan-out can go. None is set by OMCA.

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` | 200 (v2.1.212) | Session-wide total. Finished agents still count. `/clear` resets it. The error tells the model to finish the remaining work directly, so it is not retryable |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 20 (v2.1.217) | In-flight ceiling. `Concurrent subagent limit reached` explicitly says not to retry: wait for in-flight agents and read their results. ultracode sessions are exempt |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | moved (v2.1.217 set 1, v2.1.219 raised it to 3) | The docs page still describes the pre-v2.1.219 behavior, so cite the changelog. Do not write prose that depends on the number |

`scripts/delegate-retry.sh` returns early on both limit strings, before the error counter, so
a platform ceiling can never advance the three-strike breaker toward an oracle escalation.

`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (default 10) is the tighter of the two parallelism
ceilings next to the 20-concurrent-subagent cap. Exceeding it serializes silently, so a
hand-authored parallel group wider than 10 reads as a hang.

`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` controls when a slow MCP tool call is auto-backgrounded
(two minutes by default). `servers/tools/ast.py`'s own timeout is longer than that, so a
whole-tree scan backgrounds before it times out; narrower `paths`/`globs` is the documented
mitigation rather than lowering the timeout.

`CLAUDE_CODE_RETRY_WATCHDOG` governs API-level retries, not delegation. Setting it to `1`
retries `429` and `529` capacity errors indefinitely, and as of v2.1.199 raises the default
retry count for other transient errors (server errors, timeouts, dropped connections) to 300
and lifts the cap of 15 on an explicit `CLAUDE_CODE_MAX_RETRIES`. It is the documented
recommendation for unattended and CI runs. OMCA leaves it to the operator: `delegate-retry.sh`
counts subagent-level failures, which are a different plane, so this variable neither helps
nor hinders the three-strike counter.

`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` is the only lever that can raise the SessionEnd
budget, and it is user-side: a `timeout` declared in a plugin-provided `hooks.json` never
raises it. A kill at 1.5 seconds leaves this session's `bindings[session_id]` entry in
`boulder.json` behind, and recovery falls to the `SessionStart` GC in `session-init.sh`.

### `prompt_id` (hook input field, v2.1.196)

`prompt_id` is a common hook input field carrying the id of the user prompt in flight. It is
absent until the first user input of a session. `scripts/tool-loop-detector.sh` stamps it into
its one-slot window so a repeated signature carried across a user turn boundary no longer
reads as the third call of a streak.

### `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` (v2.1.132)

Set to `1` to opt out of the fullscreen alternate-screen renderer and keep the conversation in the terminal's native scrollback buffer. Useful for terminal multiplexers managing their own scrollback, or when capturing conversation output via pipe.

```bash
export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1
claude
```

### `CLAUDE_CODE_FORK_SUBAGENT` (v2.1.119)

Set to `1` to enable forked subagents in non-interactive sessions. When forked, subagents inherit the FULL conversation context of the parent session instead of starting fresh. Useful for orchestration patterns where the subagent needs the orchestrator's accumulated context (e.g., a verifier reviewing the same payload the orchestrator just produced) without an explicit handoff prompt. Off by default on external builds; opt in per session.

### `ENABLE_PROMPT_CACHING_1H` (v2.1.108)

Set to `1` to opt API key, Bedrock, Vertex, and Foundry callers into the 1-hour prompt cache TTL (vs. the default 5-minute). Cuts cost on workflows with stable system prompts that get reused across many turns within an hour. OMCA orchestration falls into this pattern — the output-style body is identical for every session. Worth setting in user `~/.claude/settings.json` `env` block for cost-sensitive deployments.

### `CLAUDE_CODE_FORCE_SYNC_OUTPUT` (v2.1.129)

Force-enables synchronized output on terminals where auto-detection misses (notably Emacs `eat`). Reduces rendering glitches on rare terminal emulators. Set when you observe corrupted output or torn updates.

### `ANTHROPIC_API_KEY` / `apiKeyHelper` / `ANTHROPIC_AUTH_TOKEN` disable claude.ai features (v2.1.139)

When any of these are set, Remote Control, `/schedule`, claude.ai MCP connectors, and notification preferences are disabled — even if a Claude.ai OAuth login is also present in the session. API-key auth and Claude.ai auth resolve to different account scopes; the platform consistently picks API-key auth when both are set, so claude.ai-scoped features become unreachable.

OMCA's core workflows (start-work, evidence gating, specialist delegation) run in-process and do not depend on Remote Control or `/schedule`. Users who need claude.ai-only features must unset the API-key variable for that session.

### `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` (v2.1.154)

Set to `1` to enable the effort selector for all deployments, including those where it is
disabled by default (API key builds, certain managed tiers). Useful for ensuring
OMCA's effort-aware hook branching works when the platform would otherwise suppress the
effort control.

### `CLAUDE_CODE_ENABLE_AUTO_MODE` (v2.1.158)

Enables auto permission mode for Bedrock, Vertex, and AWS Bedrock Foundry deployments,
where it used to be off by default. As of v2.1.207 auto mode is on by default on those
providers too, so this variable is now only a way to force it on where a deployment has
turned it off. Under `disableAutoMode: "disable"`, auto mode never runs and
`permission-denied-coach.sh` is unreachable. Relevant for OMCA users running in managed cloud deployments who want auto-mode
orchestration without the bypass-permissions confirmation flow.

### `agent` setting — honored for dispatched sessions (v2.1.157)

The `agent` key in `~/.claude/settings.json` (or project settings) is now honored for
dispatched (non-interactive) Claude Code sessions. When set, the named agent identity is
used for the dispatched session's system prompt. OMCA uses `templates/claudemd.md`
injection for sisyphus identity in interactive sessions; dispatched-session orchestration
is an advanced pattern not currently documented in OMCA's standard workflows.

### `fallbackModel` (v2.1.166)

Specifies a fallback model to use when the primary model is unavailable (e.g., capacity
limits). Set in `~/.claude/settings.json`:

```json
{
  "fallbackModel": ["claude-sonnet-5", "claude-haiku-4-5"]
}
```

`fallbackModel` accepts up to 3 models (v2.1.166), tried in order until one is reachable.

Not OMCA-specific; standard platform setting. Relevant for deployments where opus
availability is not guaranteed.

### `requiredMinimumVersion` / `requiredMaximumVersion` (v2.1.163)

Managed keys that enforce a minimum or maximum Claude Code version for the deployment.
These are org-policy keys — OMCA cannot set or override them. If your org enforces a
minimum version, ensure it is ≥ v2.1.141 to get the full v2.1.141–v2.1.167 sync
feature set.

### `CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE` — removed (v2.1.160)

This env var was deprecated in v2.1.154 and removed in v2.1.160. OMCA never referenced
it; no action needed.

---

## Observability and OTEL Attribution

### Subagent attribution (v2.1.139+)

Subagent API requests carry two request headers, and `claude_code.llm_request` OTEL spans carry the matching span attributes:

| Surface | Field | Meaning |
|---|---|---|
| HTTP header | `x-claude-code-agent-id` | This subagent's agent ID |
| HTTP header | `x-claude-code-parent-agent-id` | The spawning agent's ID (main session or the subagent's parent) |
| OTEL span attribute | `agent_id` | Same as the `x-claude-code-agent-id` header |
| OTEL span attribute | `parent_agent_id` | Same as the `x-claude-code-parent-agent-id` header |

OMCA does not configure OTEL by default. With an OTEL collector wired up, subagent token usage and latency can be attributed to specific OMCA agents (sisyphus, prometheus, executor, oracle, explore, etc.) instead of one undifferentiated `claude_code.llm_request` stream.

---

## Managed Settings Boundary

This plugin is not the policy authority. Managed settings own non-overridable org controls.

Important keys:

| Key | Purpose |
|-----|---------|
| `strictKnownMarketplaces` | Allow only approved marketplaces |
| `blockedMarketplaces` | Deny specific marketplaces |
| `allowManagedHooksOnly` | Allow only managed hooks |
| `allowManagedPermissionRulesOnly` | Allow only managed permission rules |
| `allowManagedMcpServersOnly` | Allow only managed MCP servers |
| `strictPluginOnlyCustomization` | Restrict customization to plugin-provided components. It blocks skills, agents, hooks, and MCP servers from user and project sources so they can only come from plugins or managed settings, which is exactly the shape OMCA ships in, so it does not restrict OMCA's own hooks. The hook hazard belongs to `allowManagedHooksOnly` alone: with that set and no force-enable for this plugin in managed `enabledPlugins`, every OMCA hook including the evidence gates dies silently |
| `allowedHttpHookUrls` | Allowlist for `type: http` hook endpoints. Listed for completeness; it gates a handler type OMCA has already declined |
| `sandbox.failIfUnavailable` | Fail if sandbox cannot start (fail-closed posture) |
| `parentSettingsBehavior` | (v2.1.133, managed settings only) Controls whether SDK/IDE parent-supplied managed settings apply when an admin-deployed managed tier is also present. `"first-wins"` (default): parent settings are dropped, admin tier wins. `"merge"`: parent settings apply under admin tier, filtered to tighten policy only. Has no effect when no admin tier is deployed. |
| `sandbox.bwrapPath` | (v2.1.133, managed settings only, Linux/WSL) Absolute path to a custom `bubblewrap` binary used for sandboxed Bash execution. Override when the system `bwrap` is missing, too old, or replaced by a hardened build. |
| `sandbox.socatPath` | (v2.1.133, managed settings only, Linux/WSL) Absolute path to a custom `socat` binary. Companion to `bwrapPath` — used by the sandbox's networking proxy. Override under the same conditions. |

Keep `teammateMode: "auto"` as the default collaboration baseline unless your org policy overrides it.

`scripts/permission-filter.sh` does not auto-allow arbitrary commands — it only auto-approves
known-safe package managers (npm, yarn, pnpm, bun), jq, and uv run/sync, and blocks
destructive patterns (rm -rf). A command containing a command separator, a redirect, or a
command substitution takes neither branch: it falls through to the platform decision, because
hook `if:` matching is per-subcommand and the filter only ever saw the first one. A carriage
return is matched alongside those, as hardening for shells that terminate a statement on a
bare CR, which bash does not. Globs, tilde, and `$VAR` expansion still take the fast path,
since none of them can introduce a second command. Auto mode now absorbs the dangerous-`rm` dialog itself, so
the deny branch is no longer backed by a platform prompt and must not be deleted as
duplicated behavior.

The two branches are registered on two different events, and the difference is load-bearing.
`PermissionRequest` fires only when a permission dialog is about to be shown, while
`PreToolUse` fires before tool execution regardless of permission status
(`claude-code-docs/docs/hooks.md`, PermissionRequest input). A deny registered only on
`PermissionRequest` is therefore inert for every command that never produces a dialog, and
under `permissions.defaultMode: "auto"` the classifier resolves most shell commands without
one, so "no dialog" is the normal path rather than an edge case. The `rm -rf` deny is now
registered on `PreToolUse` as well, with matcher `Bash` and no `if` filter. The
trusted-tooling fast path stays on `PermissionRequest` alone.

Do not consolidate the two. On `PreToolUse`, `permissionDecision: "allow"` skips the
permission prompt, so the auto-mode classifier and any interactive confirmation never run for
that command; only explicit `deny` and `ask` rules from settings still evaluate. Moving the
fast path to `PreToolUse` to have one registration instead of two would turn an auto-allow
covering six known tools into a silent bypass of the operator's whole permission posture for
those commands, which is a larger hole than the inert deny the split exists to fix. Both
`permission-filter.sh` and `git-destructive-deny.sh` carry an early `exit 0` on
`hook_event_name == PreToolUse`, placed after the deny and before the first allow, to hold
that line.

Protected paths sit outside all of this: writes under `.claude/**` are never auto-approved,
and the protected-path check runs before allow rules entirely, so an
`Edit(.claude/**)` allow rule has no effect. A setup flow that assumes otherwise
half-completes with no visible denial.

`/oh-my-claudeagent:omca-setup` inspects and reports on these keys but cannot write them.

---

## Output Styles

### `force-for-plugin` (re-verified 2026-06-06)

`output-styles/omca-default.md` uses `force-for-plugin: true` in its frontmatter.
This key is live and documented in the platform output-styles reference: it causes the
plugin's output style to apply automatically whenever the plugin is enabled, without
requiring the user to select it, and overrides the user's `outputStyle` setting. If
multiple enabled plugins set `force-for-plugin: true`, the platform uses the first one
loaded.

**GFM task-list checkboxes (v2.1.149):**

GitHub Flavored Markdown task-list checkboxes (`- [ ]` / `- [x]`) now render visually
in model responses. OMCA plan files use checkbox syntax (`- [ ] N. Task`) and these now
render in-session. No OMCA file changes required; this is a platform rendering improvement.

---

## OMC (oh-my-claudecode) Adoptions

A sibling project, oh-my-claudecode (OMC), independently solved several problems OMCA
also has. This sync ported five of its ideas, adapted to OMCA's bash+Python idiom rather
than copied verbatim.

**Adopted:**

| Feature | Notes |
|---------|-------|
| Session-bound plan registry | `boulder.json` moved from a single `active_plan` pointer to `{plans: {<plan_name>: {...}}, bindings: {<session_id>: {plan_name, bound_at}}}`. Fixes the clobber where two concurrent sessions working different plans overwrote each other's state. `resolve_bound_plan()` (`servers/tools/_boulder_core.py`) is the one pure-read resolution ladder every consumer calls, via direct import in Python or the `boulder_resolve.py` shim from bash |
| drift-guard hard-block Stop hook | New `scripts/drift-guard.sh`: when the last assistant turn reads as a completion claim ("done", "fixed", "implemented", etc., unless negated) but the diff still contains a stub marker (`.only`, `TODO: implement`, an unimplemented-error throw), the Stop is blocked with the offending `file:line`. Self-clearing — fixing the stub removes the marker, so there is no separate loop-guard state file. Kill-switch: `OMCA_HOOK_DISABLE_DRIFT_GUARD` |
| context-injector hardening | `scripts/context-injector.sh` now dedups injections by content-hash+realpath (reusing `injected-context-dirs.json`, which `session-init.sh` already resets every `SessionStart`) instead of re-injecting on every matching file access. The project-root walk for both the `.omca/rules` scan and the AGENTS.md/README terminator now resolves worktree-safely (a linked worktree's `.git` is a file, not a directory, so the walk tests `-e` not `-d`), so a worktree session no longer walks up into the parent repo |
| stdin-read timeout | `scripts/lib/common.sh`'s shared `HOOK_INPUT=$(cat)` read now wraps in `timeout 5 cat`, discarding on exit 124 rather than hanging indefinitely if stdin is never closed. Blocking hooks (`final-verification-evidence.sh`, `drift-guard.sh`, `task-completed-verify.sh`) treat an empty-from-timeout read as fail-closed-or-warn, not a silent pass |
| Compaction content round-trip | `pre-compact.sh` now inlines the session's next 10 unchecked plan tasks and the 5 most recent notepad decisions (tasks first, so they survive `post-compact-inject.sh`'s downstream line cap), instead of leaving compaction to rely on whatever the model happened to keep in its own summary |
| Per-subagent statusline model | `subagent-start.sh` now records each live subagent's resolved display model (e.g. `Sonnet`, `Opus 4.8`) in `subagent-models.json`; the statusline renders it per running task instead of showing only the parent session's model |

**Reframed, not ported as-is:**

- **Directives via Claude-native memory, not a new store.** OMC persists standing user
  directives ("always run tests before claiming done") in its own dedicated store. OMCA
  already has a durable, cross-session store for exactly this: Claude-native project
  memory. Rather than build a second directives mechanism, the relevant agents'
  `## Memory Guidance` sections and `output-styles/omca-default.md` now name standing
  directives as an explicit `feedback`-type memory save trigger. No new file, no new
  re-injection path.
- **Context-injector hardening stopped at hardening.** OMC's version also adds
  multi-source injection (pulling context from more than `.omca/rules/*.md` and
  AGENTS.md/README). OMCA only adopted the dedup and worktree-root fixes; multi-source
  injection was not a problem OMCA had, so it was left out rather than adding unused
  surface area.

**Probed runtime findings** (each verified against a live payload before anything was
built on top of it, rather than inferred from the docs):

- The `Stop` payload carries `last_assistant_message` and `transcript_path`; there is no
  inline `messages` array, and the undocumented probe for one was removed. Both Stop hooks
  that need the final assistant turn read `last_assistant_message` first and fall back to
  tailing the transcript JSONL. The fallback matters because the transcript file is not
  guaranteed to contain the final message at Stop time on all versions, which for
  drift-guard would be a silent guard failure rather than a visible error. The user-role
  rail in `plan-continuation-guard.sh` stays transcript-only, since the payload carries no
  equivalent field for the user turn.
- When multiple `Stop` hooks are registered, the platform dispatches all of them in
  parallel: one hook's decision can never short-circuit a sibling's execution, and any
  single hook returning `decision: block` blocks the stop regardless of what the others
  return. drift-guard was built to be correct standing alone, with no assumption about
  ordering relative to `final-verification-evidence.sh`.
- `CLAUDE_CODE_SESSION_ID` is the confirmed binding key for anything running as an MCP
  tool or agent process (live-observed in-session); bash hook scripts keep the existing
  three-tier fallback (`CLAUDE_SESSION_ID` env, then the hook payload's `session_id`,
  then `session.json`) since the hook-side env var was not independently confirmed.

---

## Deliberate Non-Adoptions (v2.1.141–v2.1.167)

Features introduced in this window that OMCA consciously declines to adopt:

| Feature | Version | Reason |
|---------|---------|--------|
| `hookSpecificOutput.additionalContext` on Stop/SubagentStop | v2.1.163 | Co-existence with `decision:block` is undocumented (schema inconclusive); exit-2 path ignores all JSON — `additionalContext` would be silently dropped alongside a block decision |
| `MessageDisplay`, `Elicitation`, `ElicitationResult`, `Setup` hook handlers | v2.1.152 | No OMCA use case; tracked in `new_platform_events` validator array (skip-on-absent semantics). Blocking PostToolBatch semantics (`decision:block`) deferred to v2 — current handler is non-blocking `additionalContext` only |
| `PostToolBatch` blocking semantics (v2) | v2.1.152 | v1 non-blocking handler adopted in v2.7.0; blocking `decision:block` behavior deferred — not documented to co-exist with batch continuation, behavior unvalidated in production |
| `skills:` preload frontmatter | v2.1.150 | Adds context-window cost on every session; OMCA's lazy slash-command / keyword paths are sufficient |
| `Agent(type=...)` spawn-allowlist in agent frontmatter | v2.1.148 | Sisyphus needs unrestricted spawn access to the full agent roster; an allowlist would require updating on every new specialist addition |
| `defaultEnabled: false` in plugin.json | v2.1.154 | OMCA is designed to activate immediately on install; inactive-by-default would break first-session experience |
| `reloadSkills` in SessionStart output | v2.1.152 | No OMCA use case identified |
| `prompt`, `agent`, and `http` hook types | (standing) | Orthogonal to OMCA's bash-script hook model |
| Monitors, Themes, Channels, LSP | (standing) | No current OMCA use case |
| `arguments:` in skill frontmatter | evaluated 2026-06 | Shell-style positional binding truncates free-form input — a slash command like `/oh-my-claudeagent:plan fix the auth bug` would bind only `$task="fix"`, discarding the rest. OMCA skills receive the full user prompt via natural expansion instead |
| `hooks:` in skill frontmatter | evaluated 2026-06 | Skill-frontmatter hooks are not visible to `validate-plugin.sh` (validates hooks only from `hooks/hooks.json`). All hook registration stays in `hooks/hooks.json` |
| `skillOverrides` / `skillListingBudgetFraction` / `maxSkillDescriptionChars` settings | evaluated 2026-06 | User-preference settings only; `skillOverrides` does not apply to plugin-shipped skills. No plugin-side adoption possible or needed |
| `initialPrompt` in agent frontmatter | evaluated 2026-06 | Fires an unconditional billable model turn per subagent; `subagent-start.sh` already injects boulder context as `additionalContext` at zero turn cost |
| `SessionStart` `watchPaths` output | evaluated 2026-06 | `FileChanged` consumer is side-effects-only (log + notify); no runtime reader benefits from an expanded watch set |
| `PostToolUse` `updatedToolOutput` | evaluated 2026-06 | Rewriting tool output post-hoc is adversarial to evidence integrity — OMCA's verification model requires the model to see literal command output |
| `plugin.json` `dependencies` field | evaluated 2026-06 | OMCA has no runtime inter-plugin dependencies; field has no consumers in this plugin |
| MCP `headersHelper` and WebSocket (`ws`) transport | evaluated 2026-06 | All OMCA MCP servers use stdio; no auth-header injection or WebSocket transport needed |

**Platform-prohibited (skipped, not evaluated):**

| Feature | Reason |
|---------|--------|
| `sessionTitle` output on `UserPromptSubmit` | Platform contract: `sessionTitle` is a `SessionStart`-only output field. Emitting it from `UserPromptSubmit` (or any other hook) is unsupported by spec; the platform ignores it outside startup/resume |

**Adopted in 2026-06 sweep:**

| Feature | Adopted in | Notes |
|---------|-----------|-------|
| `duration_ms` coaching in `bash-error-recovery.sh` | v2.7.0 | Added two branches: text-regex timeout detection (placed first in deterministic chain) and `duration_ms` ≥ 120 s fallback for slow-failure coaching (run_in_background / larger-timeout / narrower-scope). Payload probe confirmed `duration_ms` present in PostToolUseFailure Bash payloads |
| `delegate-retry.sh` `duration_ms` branch | deferred | Agent-failure PostToolUseFailure payload structure not confirmed by probe contract — `duration_ms` coverage for Agent failures is pending a dedicated probe session |
| `statusLine.refreshInterval: 5` | v2.7.0 | Applied via `omca-setup` Phase 5.6; both create and merge jq variants updated. Rationale: disk-sourced statusline reads git cache files that update on a ~5 s cadence; background-agent idle scenarios benefit from a matching refresh ceiling. Doc-claim ceiling: freshness improvement covers disk-sourced and idle-fan-out scenarios only |

**Adopted this sync (v2.1.168–v2.1.197):**

| Feature | Notes |
|---------|-------|
| `[1m]` auto-strip alignment | v2.1.173 dropped the `[1m]` context-window suffix from model identifiers platform-side; OMCA's agent docs and tables use bare model identifiers throughout |
| Per-agent `effort:` tuning | Effort raised to xhigh for sonnet/opus workers and planners, max for oracle; explore sits at medium, librarian and multimodal-looker at high |
| `sessionTitle` from boulder.json | Already adopted (v2.1.152, `session-init.sh`); re-verified against v2.1.197 and now guarded against an absent boulder file |
| Model generation move | Agent roster: oracle on `fable`, orchestrators/planners on `opus`, workers on `sonnet`; haiku retired |

**Provider-alias caveat:** every OMCA agent declares a tier alias in `model:` frontmatter
(`opus` or `fable`) rather than a pinned generation ID, so the frontmatter never goes stale. The
generation an alias resolves to depends on the provider (`claude-code-docs/docs/model-config.md`
provider table): `opus` is Opus 5 on the Anthropic API, Claude Platform on AWS, Amazon Bedrock,
and Google Cloud's Agent Platform, and Opus 4.6 on Microsoft Foundry. That spread reaches the
whole roster now that `opus` is the only tier any agent declares, and it is the accepted cost of
not having a pinned id go stale on the next release. Note that Opus 4.6 supports `low`,
`medium`, `high`, and `max` but not `xhigh`, so on Foundry the four `xhigh` agents run at `high`,
which is the platform's documented fallback to the highest supported level at or below the one
set. The statusline still shows the true generation per subagent row, because
`statusline/subagent.py` prefers the payload's resolved `model` field and only falls back to
the frontmatter-derived label when the payload omits it.

`modelOverrides` in settings is the named provider-portability escape hatch for a deployment
that needs a specific generation. `availableModels` is the other side of that: it alone
constrains which models subagents and skills may select, independent of
`enforceAvailableModels`, and on the Anthropic API and Claude Platform on AWS a family alias
resolves to the newest version of its family the allowlist permits, so an allowlist that
includes `opus` and `fable` covers the whole roster.

**Nesting invariant:** the platform's nested-spawn depth default has moved more than once.
v2.1.217 set it to 1, and v2.1.219 raised it to 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).
The docs page still describes the pre-v2.1.219 behavior, so the changelog is the citation.
Do not write OMCA prose that depends on a specific number. OMCA's own spawn graph stays at
depth 2: only `sisyphus`, `executor`, and `prometheus` spawn further subagents; every other
agent declares `disallowedTools: Agent`. Because depth 1 is a value the platform has
actually shipped, `executor`'s research spawn is written as optional: if the `Agent` tool is
absent or the spawn fails, executor searches with Grep/Glob/Read and never reports the task
blocked on it.

**Deliberate non-adoptions (v2.1.168–v2.1.197):**

| Feature | Version | Reason |
|---------|---------|--------|
| `type: agent` / `type: prompt` semantic evidence verifier on `TaskCompleted` | v2.1.197 spec | NO-GO. Docs mark `type: agent` experimental/may-change; would roughly double LLM call volume on the task-completion path versus the existing zero-cost bash+jq gate (`task-completed-verify.sh`); targets a hypothetical mismatch failure mode with no observed incident history, while the existing deterministic hard gates (schema + freshness checks) already cover the failure modes actually seen in production. Re-evaluate only if `type: agent` graduates out of experimental and a real semantic-mismatch incident is observed |
| `worktree.bgIsolation` | v2.1.143 | Claude-native owns worktree isolation policy; OMCA documents the `worktree.baseRef` hazard (see CLAUDE.md) but does not set this key — no OMCA workflow depends on background-isolation defaults differing from the platform default |
| `sandbox.credentials` | v2.1.187 | Managed-settings-adjacent credential-scoping key; outside OMCA's ownership boundary (sandboxing is Claude-native's domain per the Ownership Model above) |
| `autoMode.classifyAllShell` | v2.1.193 | Would route every Bash call through the auto-mode classifier, not just unmatched ones; OMCA's `permission-filter.sh` already fast-paths known-safe tooling deterministically — classifying all shell calls would add latency without changing OMCA's allow/deny outcomes |
| `enforceAvailableModels` | v2.1.175 | The stale-pin hazard that held this back is gone: OMCA agent frontmatter now carries tier aliases only, and on the Anthropic API and Claude Platform on AWS a family alias resolves to the newest version the allowlist permits, so there is no id left to go stale. Safe to recommend once a deployment's own settings are free of pinned ids. OMCA still does not enable it by default, since the allowlist it enforces is the org's to write |
| `fallbackModel[]` | v2.1.166 | Documented above under Environment Variables; not auto-set by OMCA because the right fallback chain depends on the user's model availability and provider, which OMCA cannot infer |
| `disableBundledSkills` | v2.1.169 | User-preference key for suppressing platform-bundled skills; orthogonal to OMCA's own skill set, no plugin-side action needed |
| `autoMode` destructive-git default-block | v2.1.183 | Overlaps OMCA's own `scripts/git-master`-adjacent destructive-git denial in `permission-filter.sh` (`sudo rm -rf` guardrail). Complementary, not adopted as a replacement. OMCA's deny runs regardless of `autoMode` state now that it is registered on `PreToolUse` as well as `PermissionRequest`; while it sat on `PermissionRequest` alone, auto mode suppressed the dialog and the deny never ran, so that independence is a property of the current wiring rather than something that was always true |
| `Agent(type)` deny enforcement | v2.1.186 | No OMCA agent declares a `type` field; nothing to enforce against yet |
| Nested `.claude/` closest-wins precedence | v2.1.178 | Affects multi-root or nested-project layouts; OMCA's state lives under a single `.omca/` root per `CLAUDE_PROJECT_DIR` and does not nest |
| Background-subagent permission-prompt | v2.1.186 | Background `Agent` calls now surface permission prompts the same as foreground; this is platform UX, not a setting OMCA wires |
| Scheduled/webhook trigger reclassification | v2.1.183 | Claude-native owns `/schedule` triggers (see Ownership Model); OMCA's evidence/boulder state does not interact with trigger firing |

**Cost-governance recommendation (v2.1.178):** the `Tool(param:value)` permission syntax
(e.g. `Agent(model:fable)`) restricts a tool call's parameters at the permission-rule level.
Users running cost-sensitive deployments can add an allow/deny rule scoped to a model alias in
their own `settings.json`. This is a user-side recommendation: OMCA's
shipped `settings.json` does not set it, since the right cap depends on the deployment's
budget, not on OMCA's orchestration logic.

Write the rule in the alias form. The rule is compared against the literal input Claude sends,
before any normalization (`claude-code-docs/docs/permissions.md`), and `agents/sisyphus.md`'s
Model Routing section passes an alias when it passes a model at all, so an alias-form rule fires
on those calls and a pinned id in the rule would not. The rule worth writing is
`Agent(model:fable)`: sisyphus now instructs the orchestrator to pass no `model=` in the usual
case and to reach for `model="fable"` only when a task needs oracle-class depth, so `fable` is
the only alias a delegation still sends explicitly.

**The coverage is partial, by construction.** An agent that takes its tier from frontmatter is
spawned with no `model` parameter in the tool call at all, and an omitted parameter is never
matched. So an `Agent(model:...)` rule gates explicit per-call overrides only, never the
frontmatter-declared tier of the roster agents. There is no permission-rule form that caps the
latter; `availableModels` is the lever for that.

Two further parameter forms are documented but easy to miss: `Agent(isolation:worktree)`
gates which delegations may run in an isolated worktree, and `Bash(run_in_background:true)`
gates backgrounded shell commands. Both are one-line additions to the same user-side
allow/deny set.

`workflowSizeGuideline` belongs in the same cost-governance conversation but does not do
the same job: it bounds native dynamic workflows only and does not constrain direct `Agent`
fan-out, so it cannot cap an OMCA parallel group. Its `medium` tier is already under 15
agents, above OMCA's usual ceiling. Setting it in `settings.json` hides the matching
`/config` row.

`askUserQuestionTimeout` should stay at its default `never` in any deployment running OMCA.
prometheus treats a skipped interview question as resolving to that question's default, so
a timed-out dialog silently answers a planning question, and `omca-setup`'s
settings-mutation confirmations could auto-continue. User settings only; OMCA does not set
it and `--check` can at most warn.

`autoMode.environment` is per-organization prose OMCA cannot infer, the same class as
`fallbackModel[]`. Its scope is user settings, `--settings`, or managed settings only, never
project `.claude/settings.json` and never `.claude/settings.local.json`, so no future
`omca-setup` phase may emit an `autoMode` block into project settings. When
`permission-denied-coach.sh` fires on something that should have been allowed, inspect the
effective ruleset with `claude auto-mode defaults`, `claude auto-mode config`, `claude
auto-mode critique`, and `claude auto-mode reset`.

`teammateDefaultModel` is best left `null` so teammates inherit the lead session's
`/model`. It is deliberately not part of `omca-setup`'s auto-merged settings set, because
the right value depends on model availability, provider, and budget.

Screen-reader users should set `CLAUDE_STATUSLINE_NERD_FONT=0`, which yields plain-text
glyphs today. OMCA does not document a `CLAUDE_AX_SCREEN_READER` branch as working, because
neither the settings nor the flag form is confirmed to reach the statusline environment. The
larger accessibility gap is `statusline/core.py`'s unconditional ANSI escapes, tracked in
`docs/reference/known-issues.md`.

`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` (default 10) and
`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` are documented in the environment-variable
section and in `CLAUDE.md`; neither is set by OMCA.

---

## Platform Sync (v2.1.199–v2.1.220)

**Adopted this sync:**

| Feature | Notes |
|---------|-------|
| Hook `timeout` is seconds, not milliseconds | The two `"timeout": 5000` values in `hooks/hooks.json` were 83-minute caps, the opposite of the intended 5-second tightening, and are now `5`. The per-event defaults range from 1.5 seconds for `SessionEnd` up to 600 for a `command` handler |
| Quoted shell form on every command handler | Each handler invokes `${CLAUDE_PLUGIN_ROOT}/scripts/...`, which resolves into the marketplace cache under the user's home; in shell form a space anywhere in that path splits the command, so every `command` value now quotes the placeholder. Exec form (`args` present) was tried and rejected: it spawns `command` as a real executable with no shell, and a `.sh` file is not executable on native Windows, so every handler would fail to spawn there with no error signal, and setting `args` also makes the platform ignore the `shell` field. Exec form stays available for handlers whose `command` is a genuine cross-platform binary |
| `statusMessage` on user-perceived slow handlers | Spinner labels on `session-init.sh`, `context-injector.sh`, `comment-checker.sh`, and the `*-error-recovery.sh` family. Not blanket-applied: most handlers finish in milliseconds and a label for them reads as noise |
| Compound-command fall-through in the trusted-tooling fast path | Hook `if:` matching is per-subcommand, so `jq . a.json && rm -rf ~/x` reached the jq auto-allow branch. A command whose trimmed text contains a command separator, a redirect, or a command substitution now falls through to the platform decision: `\|`, `;`, `&`, `<`, `>`, a backtick, `$(`, a literal newline, or a carriage return. The bare `&` covers `&&` and `&>`, the newline covers multi-line commands, and the carriage return is hardening for shells that terminate a statement on a bare CR, which bash does not. Globs, tilde, and `$VAR` expansion still take the fast path, since none of them can introduce a second command. The `rm -rf` deny branch still runs first, so the deny path is unchanged |
| `context: fork` skills pin `background: false` | Forked skills background by default from v2.1.218, and a backgrounded fork gets the narrower background-subagent tool set with its result a turn later. metis, momus, and hephaestus pin `false` so momus's OKAY/REJECT verdict stays inline for the bounded review loop and hephaestus's edits stay inside `/rewind` checkpoint coverage |
| `disable-model-invocation: true` on handoff | Replaces a workaround that told users to disable the whole plugin, and retires a `skillOverrides` recommendation this ledger already called inert for plugin skills. The `handoff` keyword now degrades to an advisory nudge toward the slash command and is described that way everywhere |
| Subagents background by default (v2.1.198) | Every "no `run_in_background`" instruction described the opposite of what happens. `run_in_background=false` is now explicit at every fan-out call site in `commands/start-work.md`, `agents/sisyphus.md`, and `agents/executor.md`. The lever stays at the call site because `github-triage` wants background deliberately |
| `plansDirectory` resolution | `~/.claude/plans` was hardcoded as both the authoring and the discovery surface, so with the setting on, prometheus wrote where `/start-work` no longer looked. Both now resolve the directory: the setting when present (relative to the project root), else `~/.claude/plans`, with an active plan-mode path overriding |
| Hook event tables regenerated from the registry | The table advertised nine events with no handler, omitted `PermissionDenied`, and pointed at two scripts deleted in the v2.10 refactor. `scripts/validate-plugin.sh` now diffs the table against `jq -r '.hooks \| keys[]'` in both directions, so it cannot re-drift silently |
| `last_assistant_message` on Stop/SubagentStop | Both Stop hooks read the final assistant turn from the payload field first, with the transcript tail kept as fallback because the transcript is not guaranteed to hold the final message at Stop time. The undocumented `.messages` probe is gone. drift-guard's whole purpose is catching a completion claim in that message, so a miss there was a silent guard failure |
| Stop hooks block via `decision: block` | `plan-continuation-guard.sh`, `final-verification-evidence.sh`, and `drift-guard.sh` now write Stop decision-control JSON (`decision` plus `reason`, nothing else) and exit 0 instead of writing to stderr and exiting 2. `task-completed-verify.sh` is the only turn-gate or task-gate hook left that blocks via exit 2; the PreToolUse and PermissionRequest deny hooks (`git-destructive-deny.sh`, `sed-grep-deny.sh`, `executor-grep-deny.sh`) keep exit 2, which is the only block shape those events have |
| Tier aliases in agent frontmatter | Every agent declares a tier alias (`opus`, `sonnet`, `fable`) instead of a pinned generation id, so a provider resolves it to the newest generation its allowlist permits and nothing goes stale on the next model release. The subagent-start display map gained alias arms above its full-id arms, which remain only as frontmatter compatibility for an agent file that pins a generation again; the hook reads frontmatter, not the spawning call. And `omca-setup` no longer writes `ANTHROPIC_DEFAULT_OPUS_MODEL`: a default-model pin overrides the alias and reintroduces exactly the staleness the alias removes |
| `Write(.omca/**)` dropped from the recommended allowlist | `Write`/`NotebookEdit`/`Glob` path rules are accepted but never match, and now emit a startup warning. `Edit(.omca/**)` plus `Read(.omca/**)` covers the intent, since `Edit` governs every file-editing tool including `Write`. The doctor's stale-entry warnings flag the removed rule for already-configured users |
| Spawn budgets: session cap, concurrency cap, depth default | `delegate-retry.sh` gained early-return branches for the concurrency and session ceilings, returning before the error counter so an infrastructure limit can never advance the three-strike breaker toward oracle. `commands/start-work.md` gained a parallel-group width note, and `github-triage` gained a total-item cap with an explicit skipped-item list instead of silent truncation |
| `file_read` no longer materializes whole files | The reader called `read_text().splitlines()` unconditionally and the size guard applied only to unbounded reads, so a bounded read of a huge file loaded all of it and could emit one unbounded line. It now streams the window with `islice` while still counting total lines for the footer, and caps any single line at 2000 characters with a truncation marker. The size ceiling was deliberately not extended to bounded reads: offset/limit is the documented escape hatch for large files |
| `session_search` scans spilled tool results | Large tool outputs now spill to `<slug>/<session>/tool-results/*.txt` with only a preview inlined, so a flat `*.jsonl` glob under-reported on exactly the queries the tool exists for. Sidecar hits are searched with the same excerpt budget under role `tool`, ordered by file mtime since sidecars carry no timestamp. `<session>/subagents/` is deliberately out of scope |
| MCP "not connected" is classified | The `omca` server is plugin-provided, so `evidence_log` and `boulder_write` fail during any reconnect window. `json-error-recovery.sh` matched neither the bare nor the wrapped form of that error and exited silently. The new branch points at `claude mcp list` / `/mcp` and states that the evidence call must be retried, not skipped |
| `subagentStatusLine` per-task `effort` and `contextWindowSize` | OMCA authors the effort values in agent frontmatter, so per-row effort is free signal, and a percentage-of-window row beats a raw token count when tasks run on different windows. Per-task `effort` is a bare string or int, not the main line's dict |
| MCP connect diagnostics in the doctor | The health check probed only the stdio server and punted on the two HTTP servers, which is precisely where `claude mcp list` and `/mcp` surface HTTP status and error text. Hidden leading or trailing whitespace in a configured URL is named as a cause of a URL that looks right but never connects |
| `--doctor` namespaced and scoped | The platform's `/doctor` (alias `/checkup`) is now fix-capable. OMCA's own `--doctor` is read-only and OMCA-scoped, so it is now written as `/oh-my-claudeagent:omca-setup --doctor` with "fix my setup" routed to the built-in. `just doctor` is a third, contributor-facing surface |
| `prompt_id` replaces a faked turn boundary | The loop detector's one-slot window reset only on signature change, so a repeat carried across a user turn could read as the third call of a streak. The window now stamps `prompt_id` and resets on either change. An absent field compares equal on both sides, so older clients and pre-existing state files behave as before |
| Agent `name:` values containing `:` fail CI | The platform hard-rejects such an agent at load time. No shipped file violates it, but the scaffold could produce one, so the validator and `just new-agent` both refuse it now |
| `DirectoryAdded` tracked, not adopted | Tracking half only: the event exists as a changelog line with no section, matcher table, or input schema, so a handler would be built on a guessed payload |
| The `tools: Read` carve-out removed | The rules file, the validator, and `agents/multimodal-looker.md` all described an exception no shipped agent uses. Since `tools:` is a strict allowlist whose mis-listing launches an agent with zero tools, the carve-out invited a contributor to restore it. Any `tools:` key is now a validator failure |

**Roster change this sync (maintainer decision, not a platform feature):**

The `sonnet` tier is retired from the roster. `executor`, `explore`, `hephaestus`, `librarian`,
and `multimodal-looker` declare `model: opus`, and each drops an effort level so the tier move
does not also raise reasoning depth: `executor`, `hephaestus`, `librarian`, and
`multimodal-looker` at `medium`, `explore` at `low`. `oracle` is unchanged at `fable` and `max`;
`sisyphus`, `prometheus`, `metis`, and `momus` are unchanged at `opus` and `xhigh`.

Three consequences worth stating plainly. The model column stopped discriminating, so
`agents/sisyphus.md`'s Model Routing section now presents two tiers and names effort as the
dial, with the usual correct call passing no `model=` at all. `servers/categories.json` inherited
the same collapse: four of its five categories name `opus` and only `hardest` names `fable`, so a
consumer reading `.value.model` sees two outcomes across five category names, and the schema has
no effort field to carry what actually separates them. And per-token cost rises for every
delegation that used to run on Sonnet, with the lower effort levels as the offset.

Earlier sync tables in this document record the roster as it stood at the time of that sync. The
tables under Core Concepts and Agent Reference are the live state.

**Document-only this sync (facts and hazards with no code change):**

| Fact | Consequence for OMCA |
|------|----------------------|
| Subagent rate-limit and API errors reported to the parent | Partial output returns as a success, so `delegate-retry.sh` never sees it. The real residual is that `RETRYABLE_PATTERNS` has no `usage.limit` or "terminated early" pattern, so the documented payload falls to the generic branch |
| `AskUserQuestion` no longer auto-continues | prometheus's interview and `plan-mode-handler.sh`'s auto-approve assumption both stall indefinitely in `-p` and background runs. Unattended runs must not depend on a question resolving itself |
| Stacked slash-skill invocations | `/metis /momus` is now typable. The answer stays `/oh-my-claudeagent:plan`, which already sequences them |
| `CLAUDE_CODE_RETRY_WATCHDOG` | An API-retry knob, not a delegation one: it retries `429`/`529` capacity errors indefinitely and, as of v2.1.199, raises the transient-error retry default to 300 and lifts the cap on an explicit `CLAUDE_CODE_MAX_RETRIES`. Documented as the recommendation for unattended and CI runs. It does not touch `delegate-retry.sh`'s counter either way, so the choice is the operator's |
| Project-scoped plugins load from worktrees (v2.1.200) | Below that version, a `--plugin-dir` install meant worktree-isolated runs executed with no OMCA hooks and no MCP server. This checkout is project-scoped |
| Protected paths: `.claude/**` writes are never auto-approved | The protected-path check precedes allow rules entirely, so `permissions.allow: ["Edit(.claude/**)"]` has no effect. Setup flows that expect it to work half-complete |
| `EnterWorktree` confirms outside `.claude/worktrees/` | No `EnterWorktree` callsite exists; `--worktree` is prompt-injected paths plus boulder bookkeeping |
| Auto mode absorbs dangerous-`rm` dialogs | The platform dialog is no longer the backstop behind `permission-filter.sh`'s deny branch, so nobody should delete that branch as duplicated platform behavior. It also meant the branch was not reached at all while the script sat on `PermissionRequest` alone: no dialog, no event, no deny. Fixed by registering the deny on `PreToolUse` too |
| `rm -rf` inside `$(…)`, backticks, and `<(…)` now prompts even in bypass and auto mode | The platform does check inside command substitution. The residual on OMCA's side is the `^` anchor on the deny regex, deliberately kept: an unanchored pattern would deny `grep -rn "rm -rf" scripts/` |
| Bash permission analysis fails closed | File-descriptor redirects, commands over 10,000 characters, and zsh subscripts now fail closed rather than being parsed optimistically |
| Auto-mode classifier is Sonnet 5, validated and pinned per session | Correcting a stale "not currently used by OMCA" clause: `PermissionDenied` is registered and `permission-denied-coach.sh` returns `retry: true` inside `hookSpecificOutput`, the only place the platform reads it for this event |
| Auto mode is on by default on Bedrock, Vertex, and Foundry as of v2.1.207 | The opt-in that older OMCA prose described as required is no longer required. Under `disableAutoMode: "disable"`, `permission-denied-coach.sh` is unreachable |
| `useAutoModeDuringPlan` (default `true`) | Governs whether prometheus, metis, and momus shell calls prompt one by one. Not read from shared project settings |
| `pluginConfigs` is not read from project `.claude/settings.json` as of v2.1.207 | A `pluginConfigs` block in a repo-committed settings file is a silent no-op. The preset examples say so now |
| Agent-frontmatter hooks require the agent's folder to be trusted | For OMCA's primary install path, the plugin cache, that never happens, so frontmatter hooks would fail silently. This is what makes the hooks.json-only convention load-bearing rather than stylistic |
| MCP tool calls auto-background after two minutes | `servers/tools/ast.py`'s 300-second timeout is past that threshold, so a slow whole-tree scan backgrounds before its own timeout fires. Do not lower the timeout; narrower `paths`/`globs` is the documented mitigation. `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` is the knob |
| Plugin MCP servers torn down on mid-session re-sync (v2.1.210), not reconnecting after an idle web session woke (v2.1.211) | Two confirmed ways the `omca` server vanishes mid-plan. Operator remedy: run past v2.1.211, and re-issue the tool call rather than skipping the evidence step |
| Plan approval could overwrite the plan file with a stale snapshot (v2.1.210) | Resurrecting checked boxes falsifies both checkbox-derived completion and `plan_sha256` evidence binding, so the practical version floor for plan-driven work is v2.1.210 |
| Plan-mode Bash could mutate files unprompted before v2.1.212 | prometheus, metis, and momus all grant Bash and none asserts read-only |
| Read and Grep invalid-regex and null-byte fixes | On clients before v2.1.208 a zero-result Grep can be a rejected regex rather than an absent match. Re-run with a simpler pattern before concluding something is not present |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` default 10 | Tighter than the 20-concurrent-subagent cap. Exceeding it serializes silently, so a hand-authored parallel group wider than 10 reads as a hang |
| WebSearch session cap of 200 | The context7-first prescription already conserves it |
| `/fork` is a background session; `/subtask` is the in-session subagent | Both are Claude-native. `/subtask` is user-driven and untracked by boulder or evidence, unlike an `Agent()` delegation. Neither is the skill-frontmatter `context: fork` |
| Bundled `/verify`, `/code-review`, and `/deep-research` are manual-invocation only | No evidence path may be built on implicit skill invocation |
| `/code-review` vs oracle | Diff review, branch-versus-upstream, `--fix`, `--comment`, effort calibration, and background review with its own context window are Claude-native's. oracle keeps depth review, stuck-debugging escalation, and architecture tradeoffs. `/code-review` is `disable-model-invocation`, so it is not a delegation target |
| `/deep-research` vs librarian | librarian is version-matched library and API lookup with no verification layer. `/deep-research` is user-invoked and its value is per-claim cross-checking. OMCA's research path has no claim verification, which the no-second-wave rule otherwise papers over |
| Background agent result honesty | The platform now covers one failure mode the barrier rules partly defended against. The rules stay as defense in depth so a future sync does not strip them |
| Background task notifications state that no human input occurred | That anti-fabricated-consent wording is platform-injected, not OMCA-authored. No agent body should be edited to claim or restate it |
| `--max-budget-usd` halts running background agents | Print mode only. A halted batch is a distinct failure from a stub return: relaunch rather than logging evidence for unfinished work |
| `--forward-subagent-text` | The only way to see why a delegated executor returned a stub in headless mode. Documented as a recipe; promote it if an eval harness that asserts on delegated behavior is built |
| Skills and commands changed mid-session appear in the slash menu (v2.1.216) | Live detection covers `SKILL.md` text only, and it covers a skill folder that is also a plugin. Changes to a plugin's `hooks/`, `.mcp.json`, `agents/`, and `output-styles/` still need `/reload-plugins` (`skills.md`), so editing an OMCA hook script or the `omca` server still requires a reload while editing a `SKILL.md` body does not |
| Positional `$1`/`$2` are preserved verbatim in skill bodies | Removes a latent authoring hazard: an `awk '{print $1}'` inside a SKILL.md body now survives |
| Memory index warning measures loaded content only | The line and byte thresholds do not count frontmatter |
| Agent view dispatch resolves a bare first word to a subagent name | `explore`, `executor`, and `oracle` are ordinary English words that plausibly open a dispatch prompt. Hazard note only; nothing is renamed |
| Teammate frontmatter: `skills` and `mcpServers` are ignored, coordination tools are always kept | `disallowedTools` cannot remove SendMessage or the task tools, and the agent body is appended to the teammate prompt rather than substituted for it, so the Team Eligibility table must not be read as an exclusion mechanism |
| Teammate model and fast mode are fixed at spawn | Per-delegation model routing does not apply to teammates. Native plan approval gates the teammate path |
| Native shared task list and `/tasks` vs boulder | Native owns in-session teammate coordination; boulder owns cross-session plan binding plus the sha256 and evidence gating. Naming `/tasks` here is what keeps someone from building an OMCA equivalent |
| `Elicitation`'s requester is an MCP server, not the model | Correcting the event description above |
| Exit-2 blocks land even when stdout JSON fails schema validation (v2.1.214) | Audit came back clean: every OMCA blocking path writes to stderr only. The stderr-only convention is load-bearing, not stylistic |
| Hook infrastructure errors are not user rejections (v2.1.212) | OMCA emits `continue: false` nowhere, so only this half applies, and it holds reliably from v2.1.212 |
| `continueOnBlock` is a `type: prompt` / `type: agent` field | Not a PostToolUse field. OMCA is `type: command` only, so the standing "future hooks declare `continueOnBlock: true`" advice was never actionable |
| `PostToolBatch` blocking semantics are now documented | The documentation blocker is resolved; the non-adoption stands on minimize-to-core grounds. Caveat for anyone porting a handler: `tool_calls[].tool_response` is the serialized string, not PostToolUse's structured output |
| `once`, `shell`, and the http/prompt/agent handler types | `once` is structurally inert given that skill-frontmatter hooks are a standing non-adoption, `shell` is Windows-only, and `allowedEnvVars` is moot with no http handlers |
| `maxTurns` in agent frontmatter | Shipped in v2.2.0 and reverted after user-observed truncation. Recording it here so its absence is distinguishable from ignorance, which is how it got re-added last time |
| Multi-second slowdown with many deny/ask rules, fixed v2.1.208 | The version floor to cite when recommending `/fewer-permission-prompts`. OMCA's own allow set is nowhere near pathological |
| Managed settings consented from a non-interactive run, fixed v2.1.207 | A managed policy consented during a `-p` or SDK run could change deny rules underneath OMCA's hooks. Hooks evaluate first, so only `allowManagedHooksOnly` can disable them |
| `strictPluginOnlyCustomization` | It confines skills, agents, hooks, and MCP servers to plugin or managed sources, which permits everything OMCA provides, so it needs no OMCA response. The hook-death hazard is `allowManagedHooksOnly` alone: with that set and no force-enable in managed `enabledPlugins`, every OMCA hook including the evidence gates dies silently |
| `allowedHttpHookUrls` | Completeness only; it gates a handler type already declined |
| `disableAgentView` | Under it, `github-triage`'s background fan-out and the `subagentStatusLine` renderer lose their surface. No OMCA agent declares `background: true`, so nothing else is affected |
| `sandbox.filesystem.disabled` | It relaxes filesystem isolation for sandboxed Bash. It does not lift the Read tool's project-root scoping, so `file_read` is still needed for out-of-root reads |
| `sandbox.network.strictAllowlist` (PROVISIONAL) | Changelog-only, absent from the sandboxing and settings pages. Real symptom: librarian drives `gh api` through sandboxed Bash, so an allowlist without `api.github.com` reads as a broken agent. The stdio MCP server is unaffected |
| Reserved MCP server names (`Claude Browser`, `Claude Preview`) | Forward-looking; it matters only if a browser-adjacent OMCA server is ever added. Not worth a validator check |
| `/clear` resets the cost counter | The statusline renders the reported total verbatim and asserts nothing about its lifecycle |
| REVIEW.md | A Claude-native review-service surface, not a plugin one: `code-review.md` documents it under the managed Code Review product and states that local `/code-review` does not read it. The service reads the reviewed repository's own root, so a copy travelling inside an installed plugin cache would be inert for the user's project, and OMCA ships none |
| `showClearContextOnPlanAccept` | `plan-mode-handler.sh` auto-allows ExitPlanMode, so the accept screen is normally suppressed in OMCA sessions. Verify against a live plan accept before stating that as fact |
| `disableWorkflows` and `workflowKeywordTriggerEnabled` | The kill switches beside the `ultracode` rename. No live collision: the keyword detector's patterns are disjoint from `ultracode` and off by default |
| `ultracode` keyword fired on non-human input | Design-parity lesson. `keyword-detector.sh` has provenance rails for agent id and task notifications but no webhook or relayed-comment check, and no payload field for one has been probed. Do not guess a field name |
| `Agent` tool hardened against indirect prompt injection | Both content-returning agents already carry the rail |
| `mode` param deprecated; subagents inherit the parent permission mode | Corroborates the CI-enforced rule that plugin agents declare no `permissionMode` |
| `skillListingMaxDescChars` | The 1,536 figure is now a settable default rather than a fixed platform limit. OMCA's thresholds need no change, since the 512 soft cap keeps every description far below either number |
| `effortLevel`, `fastMode`, `fastModePerSessionOptIn` | The precedence chain runs settings `effortLevel`, then session `--effort` or env, then agent frontmatter, then per-invocation. OMCA depends on frontmatter winning over the settings default, so the chain is worth having written down |
| `alwaysThinkingEnabled` and `MAX_THINKING_TOKENS` | `thinking.enabled` is a documented statusline payload field (`statusline.md`: whether extended thinking is enabled for the session), so the render has a real input source and needs no OMCA change. The half that matters is Fable 5: `MAX_THINKING_TOKENS=0` disables thinking on the Anthropic API except on Fable 5, which cannot have thinking turned off, so oracle rows keep the thinking marker even at `0` |
| Subagent model override reverted on resume before v2.1.211 | `subagent-models.json` records the frontmatter model, not the effective one. That divergence is exactly why the subagent statusline prefers the payload field |
| `mcp_server_errors` | A headless stream-json field available only with `--mcp-config`. It is a headless-only diagnostic, separate from the interactive `claude mcp list` and `/mcp` path, and does not belong in the doctor's checks |
| `SessionStart` hook streaming and idle reaping (v2.1.204) | A mid-hook reap leaves `session-init.sh`'s state resets half applied. Measured runtime is well under the budget, so no `timeout` is warranted for that reason |
| `SessionStart` source `"fork"` | A fork's SessionStart wipes the live parent's per-subagent model map, dedup map, and counters, and overwrites the shared session file so the parent's SessionEnd deletes the wrong boulder binding. But `"fork"` is the wrong gate to fix it on: background sessions report `"startup"` while `/branch` and `--fork-session --resume` report `"fork"` and want the reset. The safe half is preferring the payload's own `session_id` in `session-cleanup.sh` |

**Deliberate non-adoptions this sync:**

| Feature | Reason |
|---------|--------|
| MCP `roots/list` for additional working directories (v2.1.203) | OMCA's state lives under a single `.omca/` root per `CLAUDE_PROJECT_DIR`. Honoring roots would let `evidence_log` and `boulder_write` write into a second `.omca/` tree while every gate keeps reading the cwd-git-root tree, a net regression of the evidence-first invariant |
| Per-server `request_timeout_ms` in `.mcp.json` | Not documented in `mcp.md`. The documented per-server key is `timeout` in milliseconds; the v2.1.206 changelog names `request_timeout_ms`, which `mcp.md` does not mention. The 60-second per-request timer it refers to covers HTTP, SSE, and claude.ai connector servers only: stdio and WebSocket servers have no per-request timer (`mcp.md`). The `omca` entry is stdio, so the claimed unreachable timeout band does not exist and `ast.py`'s 300s ceiling is not capped. A stdio call is bounded only by the per-server `timeout` (unset here, so it falls to `MCP_TOOL_TIMEOUT`'s default of about 28 hours) and by the 30-minute stdio idle timeout (v2.1.203+); a main-conversation call past two minutes moves to a background task (v2.1.212) rather than aborting |
| `skillOverrides` for plugin-shipped skills | Does not apply to plugin skills at all. Superseded for the handoff case by `disable-model-invocation` |
| Skill re-invocation no longer duplicating instructions | No OMCA text ever discouraged re-invocation for context reasons, and the repeatedly-invoked skills are the small ones. Recording it would log a non-event |
| `effortLevel` daemon-fork fix | A settings key OMCA does not set, on a spawn path no OMCA agent uses |
| Subagents less likely to re-delegate | A tendency, not a hard block. The injected block it would justify trimming is mostly barrier and output-contract text addressing a different failure mode, and trimming it means regenerating golden baselines and two bats suites to save under a kilobyte per spawn, while weakening the one agent that can still spawn |
| Project verify-skill rewrite frequency | The local verify skill is gitignored, platform-managed, and ships to nobody. `just ci` plus `scripts/validate-plugin.sh` are the authoritative definitions in tracked files |
| `--json-schema` invalid-schema and `format` fixes | No `--json-schema` consumer. Agents return prose with headers by contract, and the leaf-worker output mandate depends on that; a structured-output contract would be a separate design change |
| `/commit-push-pr` push allow-set widening | Permissions are Claude-native's. OMCA authors no push guardrail, and adding one would duplicate the platform's auto-mode git handling |
| `/code-review` quality deltas between model generations | Model-quality deltas shift every release and OMCA's pins are justified on role fit, not benchmark position |
| Integer env vars accepting scientific notation | OMCA parses no numeric env vars, and the hook `timeout` field is a JSON number rather than an env var |
| Backgrounded `cd` reporting an unchanged cwd | The correction arrives in the tool result the model reads. OMCA has no absolute-path rail of its own to cite it against; that rail is platform-injected |
| Late-appearing `.claude/*` symlink sandbox reconciliation | Sandboxing is Claude-native's. OMCA creates no `.claude/*` symlinks and keeps no state under `.claude/` |
| `CLAUDE_CODE_PROCESS_WRAPPER` | No OMCA surface reads process ancestry. The in-use-marker sweeper uses liveness checks on platform-written markers, which a wrapper in the chain does not change |
| Malformed bracket patterns in globs | All OMCA rule globs are bracket-free, no ignore or worktree-include file exists, and the injector's bash pattern match treats a malformed group as a literal |
| Compound `cd` with only a `/dev/null` redirect | `permission-filter.sh` never inspects redirects, so those commands fall through to the platform decision identically before and after |
| Spurious prompt-injection warnings | OMCA's injected context is the trusted plugin-script class the fix stops flagging. The adjacent thing OMCA owns, sanitizing notepad content on post-compact injection, addresses a different concern |
| Launcher-overwrite `/doctor` report | Launcher and auto-updater are Claude-native install machinery. Adding a launcher probe to `omca-setup` would duplicate a native check and produce a finding OMCA cannot remediate |
| `EndConversation` tool | Un-denyable by construction, main-conversation-only, and invisible to `PreToolUse`, `PostToolUse`, and `PermissionRequest`. Adding it to a `disallowedTools` list would be a rule the platform ignores |
| `pkill -f` self-match fix | No `pkill` callsite exists; the marker sweeper uses a liveness check |
| Skill and plugin frontmatter booleans accepting yes/no/on/off | The validator performs no boolean-value validation to relax. Canonical `false` is what the `background:` change writes |
| Memory `modified` timestamp | Claude Code never adds frontmatter to a file that has none, and the only file the consolidation skill writes is the frontmatter-less memory index. The stamp is rewritten on every write, so a preserve-verbatim guideline would state a false invariant |
| `background: true` on explore and librarian | Adopted in v2.2.0 and removed in v2.8.2 because a background task notification carries only a trigger and an output path, which produced confabulated stub replies and indefinite re-querying of finished agents. Re-adding recreates that loop |
| `maxTurns` | Shipped and reverted in v2.2.0 after user-observed truncation. Runaway control lives at the hook layer instead: the error-count breaker and the tool-loop detector both fire at three |
| Plugin `workflows` manifest field | The delivery mechanism for a dynamic-workflow rewrite that is itself declined. Adopting the field with no script ships an empty component path |
| Dynamic workflows as a replacement for `/start-work` | The blocker is hook coupling: a workflow runtime driving agents in code produces no Stop events for `plan-continuation-guard.sh` and `final-verification-evidence.sh` to gate on. Resumability and out-of-context intermediate results are the capabilities OMCA genuinely lacks here |
| The advisor tool as an oracle replacement | Three blockers: Anthropic-API only while OMCA supports Bedrock and Vertex, a Fable-class main model would need a Fable-class advisor and none is offered, and it is experimental. Its full-transcript-context advantage is real, as a user-side complement |
| Nested subagent stream-json forwarding at depth 2 and beyond | No stream-json consumer. Revisit only if the nesting policy changes |
| `asyncRewake` | The proposed fit misreads `post-edit.sh`, which only logs and always exits 0. The format-and-lint hook is synchronous and project-local, so adopting this would need carve-outs in two load-bearing rules for no gain |
| MCP `url` without `type` error message | Two `.mcp.json` entries already declare `"type": "http"` and the third is stdio, so this error cannot fire against OMCA's config |

---

## Verification

When updating plugin docs or runtime contracts, verify with:

```bash
bash scripts/validate-plugin.sh
just test-hooks
```

Full CI pipeline:

```bash
just ci    # fmt-check + lint + test
```
