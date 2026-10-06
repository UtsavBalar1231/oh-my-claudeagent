# Contributing to oh-my-claudeagent

## Prerequisites

- `jq`, used by the eval procedure in `tests/evals/README.md`
- `bun` 1.4.2 or later, runtime for the MCP server, the hooks module, the status line and the scripts
- `ast-grep` CLI (`ast-grep` or `sg`), structural code-search tools
- `just`, task runner for dev commands. Its recipes run in bash, so on Windows run them from Git Bash
- `claude`, Claude Code 2.1.288 or later, which loads the mod: `just test-mod`, the validator's engine group and `just qa` need it
- `pre-commit`, which runs the git hooks that `just setup` installs
- `uv`, which `just bench` uses to install a baseline whose status line is the Python renderer

Run `just setup` to install the pre-commit git hooks.

To typecheck after every edit, add a `PostToolUse` hook matching `Write|Edit` to your own `.claude/settings.json` with the command `bun "${CLAUDE_PROJECT_DIR}/scripts/postedit-check.ts"`. After an edit to a `.ts` file it runs `just typecheck` and hands the first lines of a failure back to the session as context.

Structural changes to a directory (new file, moved entry point, changed layout) update that directory's `AGENTS.md` in the same change.

## Adding a hook

A hook is TypeScript in one of two homes. Skipping the registration step produces dead code:

1. **Write the feature.** A feature that needs only mod-reachable events lives in the mod: a module that `hooks/register.ts` dispatches to. `register.ts` is the only file that calls `on()`. A feature that needs a settings-hook event (`PreToolUse` with agent fields, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `UserPromptExpansion`, `SubagentStart`, `TaskCompleted`, `Stop`, `SessionStart` for `clear` or `compact`) is a handler under `servers/hooks/`. Put a `*.spec.ts` beside it. No handler returns an allow decision, and nothing is registered on `PermissionRequest`. A hook may deny, ask or advise, and an allow comes only from the user's permission rules.

2. **Register it.** In `servers/hooks/registry.ts`, map a server handler to its event and matcher. The event also needs an `mcp_tool` entry in `hooks/hooks.json` that calls the `omca_hook` tool. A handler the registry does not reach is dead code.

No hook is a shell or python script: `bun scripts/validate.ts --check tree` fails on any tracked file with a bash, sh or python shebang.

Use the `if` field for argument-level filtering on tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`): `"if": "Bash(git *)"` is permission rule syntax and spares the server a call. Do not use it on a handler where a narrow filter would silently disable coverage.

A change to `hooks/hooks.json` or to a handler applies only once the plugin is loaded again: closing the `/plugin` menu reloads it for you, and so does starting a new session.

## Adding an agent

Create `agents/name.md` with YAML frontmatter:

```yaml
---
name: agent-name
description: One-line role description
model: sonnet|opus|fable
effort: max|xhigh|high|medium|low
disallowedTools: Write, Edit  # use disallowedTools, NOT tools:
memory: project                   # optional; enables persistent project memory
---
```

Key rules:
- Declare the tier alias in `model:`, not a full generation ID. The alias tracks the platform's current model for that tier, so the frontmatter never goes stale. The roster uses three tiers: `sonnet` for routine workers whose scope the orchestrator fixes (search, scoped implementation, docs lookup), `opus` for agents whose output turns on judgment, and `fable` for architect-class reasoning. `haiku` remains a valid per-call override but is not what a new agent declares.
- Pick `effort:` deliberately, alongside the tier. `low` suits short scoped work that is not intelligence-sensitive, `medium` is the Sonnet 5.5 and Opus 5.5 default for day-to-day work with a clear scope, `high` is the intelligence-sensitive default for orchestration and planning, `xhigh` buys deeper reasoning for architect. Reserve `xhigh` and `max` for a measured quality gain: Opus 5.5 thinks more per turn at a given level than Opus 5 did.
- Use `disallowedTools:` to restrict capabilities, never `tools:`. `tools:` is a strict allowlist that blocks MCP tool inheritance, and an incomplete list launches the agent with no usable tools. `bun scripts/validate.ts --check claims` fails on a `tools:` key in agent frontmatter.
- Keep `name:` free of `:`. The platform rejects an agent whose frontmatter name holds a colon, so the agent never loads. The `oh-my-claudeagent:` prefix used at call sites is added by the platform.
- Do not declare `permissionMode:`. Claude Code strips it from plugin agents for security.
- Add the agent to every list of the roster: the agent catalog table in `templates/claudemd.md`, the agents table in `docs/references.md` and the agent list in the root `AGENTS.md`. `servers/categories.json` maps categories to tiers and changes only when a category does.
- Frontmatter outranks `CLAUDE_CODE_SUBAGENT_MODEL`. The order is a per-invocation model first, then the agent definition's `model:` field (`inherit` included), then the environment variable. Every agent on this roster declares `model:`, so the variable is a default that never applies here. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` does override a definition. With it set, the declared tier is ignored for every agent, architect's `fable` included.
- Keep hook internals out of agent prompts. State the behavioral rule and leave out the enforcement mechanism. An agent prompt must not mention hook handler names (`stop-gates`, `task-completed`), "X hook" as a noun (`SubagentStart hook`, `Stop hook`, `the final-verification hook`), raw `.omca/state/*.json` file paths, or specific plan names and task numbers as enforcement rationale. Write *"session termination is blocked until final-verification evidence is present"*, and avoid *"the `stop-gates` handler blocks Stop"*. Platform event names such as `TaskCreated`, `TaskCompleted` and `TeammateIdle` may appear as API contract references. Do not call them "lifecycle hooks"; say "lifecycle events" or "platform lifecycle gates". A prompt that names an internal handler goes stale when the hook is renamed, refactored or replaced with an MCP tool.

## Adding a skill

1. Create `skills/name/SKILL.md`. A directory without `SKILL.md` is ignored by Claude Code.
2. Follow existing frontmatter format (`name`, `description`, `argument-hint` if applicable)
3. If the skill should be keyword-activated, add a detection pattern to `src/core/keywords.ts`
4. A skill that omits `context: fork` expands inline in whatever session invoked it, so one invoked from the main session runs at depth 0 and keeps that session's `Agent` tool. That is what an orchestrator skill needs; `start-work` is the worked example, fanning out to `executor` agents from an inline body. `context: fork` does the opposite. It runs the body in a forked subagent one level down, where the platform may withhold the `Agent` tool depending on the configured spawn depth, so do not reach for it when the body has to delegate.
5. Keep a skill description under the 512-character soft cap and the 1,536-character hard cap. The platform truncates at the hard cap, and older clients may truncate at the soft cap. Run `just validate --check claims` before committing: it counts `description` plus `when_to_use`, warns at 512 and fails at 1,536. Move longer trigger phrases or usage notes into the SKILL.md body.
6. Keep hook internals out of skills. Skills describe what users do, and hooks automate how. Unless a skill's primary purpose is hook configuration or diagnosis, it must not mention raw `.omca/state/*.json` file paths (use the `boulder_write` and `boulder_progress` MCP tools from the omca server instead), hook handler names (`task-completed`, `stop-gates`), hook event names (`PreToolUse`, `Stop`) or hook env vars (`OMCA_DISABLED_HOOKS`). The recognized exception is `omca-setup`, which states the hook and managed-settings policy it works under and sends a diagnosis to `/omca doctor`. A file path in a skill forces users to learn internal layouts they cannot control, and every hook refactor then has to update skill prose.

## Testing

```bash
just ci                          # everything CI runs: lint, typecheck, validate, test, test-mod, test-opencode, smoke
just lint                        # oxlint with warnings denied, configured in .oxlintrc.json
just typecheck                   # the three tsc projects: the mod, the bun runtime and the OpenCode adapter
just validate                    # every validator group (bun scripts/validate.ts); the engine group needs the claude CLI
just validate --check claims     # one validator group; the others are hooks, mod, tree, engine and mcp
just test                        # every bun spec outside opencode/, including the validator specs
just test-mod                    # the mod tests, through claude plugin test .
just test-opencode               # every opencode/ spec; the ones that load OpenCode skip without opencode on PATH
just smoke                       # one claude -p session with the packaged plugin against the mock model
just qa                          # manual QA against the mock model: session smoke, install verify, live hook probe, statusline probe, live MCP probe, worktree and route-effort checks
just bench                       # the working tree against a baseline ref, through the mock model
just compare                     # OMCA against similar plugins in Docker, through a mock model (needs docker)
```

Use `just ci` before claiming a change is verified; `just test` runs the bun specs and nothing else.

CI runs each recipe's commands directly, `bun scripts/validate.ts` for `just validate` for
example, not through `just`. `scripts/validate/workflow.spec.ts` checks that CI runs every
command of the `just ci` recipes and nothing else without a stated reason.

The server specs under `servers/` need the ast-grep CLI. `just test` runs them with the other specs.

`tests/plugin-evals/` holds `claude plugin eval` cases for the health gate the planning skills
share, `plan-stops-on-degraded-runtime` and `start-work-stops-on-degraded-runtime`. They call a
real model, so they run by hand against a packaged copy, as
[their README](tests/plugin-evals/README.md) describes.

## Post-fix verification for race and timing bugs

Hook race and timing fixes are easy to claim fixed without ever re-triggering the
original failure. Follow this checklist:

1. When filing the bug, capture a reproducer (exact command sequence, timing, or fixture)
   that reliably triggers the race, rather than a description of the symptom.
2. Before closing the fix, re-run that exact reproducer against the fix commit.
3. Record the verdict in the commit message or changelog entry: reproducer ran and no
   longer fails, or reproducer still flakes under N runs.
4. If the reproducer cannot be re-obtained (for example it depended on since-changed CI
   timing), record the fix as "fix unverified end-to-end" rather than "fixed".

## Plugin configuration

**Custom paths replace defaults, except for skills**: the `commands`, `agents` and `outputStyles` fields in `plugin.json` replace the platform's default directories. To keep the default directory alongside a custom one, include the default path explicitly in the array. The `skills` field adds to the default `skills/` directory, which is still scanned.

## Rejected toolchain options

Measured on bun 1.4.2 and TypeScript 7.0.2. Each stays rejected until a new measurement shows a
gain.

- Bytecode and `bun build --compile`: `--bytecode` emits CommonJS only and gave the `omca` server
  no startup gain, and ESM bytecode needs `--compile`, an 81 MB binary per platform, to save 1 to
  8 ms.
- The transpiler cache variables (`BUN_RUNTIME_TRANSPILER_CACHE_PATH`, `NODE_COMPILE_CACHE`): no
  startup gain.
- `--smol`: no startup gain.
- `isolatedDeclarations`: 14 errors, and nothing here emits `.d.ts` files.
- `noPropertyAccessFromIndexSignature`: 298 errors for no runtime gain.
- `Bun.stringWidth` in `src/core`: the mod engine has no `Bun` global, and its widths differ
  from `displayWidth` on emoji sequences, tabs and soft hyphens.
- A per-agent `experimental.cacheTtl`: it works (probed on 2.1.288, a frontmatter `1h` reaches
  subagent requests, and `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and `FORCE_PROMPT_CACHING_5M`
  override it), but a one-hour write costs more on every write and saves only when a run idles
  past five minutes. It stays off until a billed run shows a net saving. A user can set
  `subagentPromptCacheTtl: "1h"` themselves.

## Release process

`just release <version>` is the whole process. It runs `scripts/release.ts`, which requires a
clean tracked tree, a checkout of `main` even with `origin/main`, a local `plugin` branch that
contains `origin/plugin`, a `## [<version>]` heading in `CHANGELOG.md` and no existing
`v<version>` or `plugin-v<version>` tag. It writes the version into
`.claude-plugin/plugin.json`, both version fields of `.claude-plugin/marketplace.json` and
`package.json`, commits the bump and tags it `v<version>`.

It then packages that tag's tracked files as a commit on the orphan `plugin` branch tagged
`plugin-v<version>`. `EXCLUDES` in `scripts/package.ts` leaves out the repository tooling: the
specs, `tests/`, `scripts/` except `scripts/setup-statusline.ts`, `package.json`, `bun.lock`,
the typecheck and lint configs, `CONTRIBUTING.md`, the OpenCode adapter and `video/`. Without
`package.json` and a lockfile, an install fetches no npm packages. A second commit on `main`
records the packaged commit's SHA in `marketplace.json`, as a `url` source with `ref: plugin`.

The script never pushes. It prints one atomic push of both branches and both tags,
`git push --atomic origin main plugin v<version> plugin-v<version>`, so the stamped SHA never
names a commit the remote lacks. The packaged tag is named `plugin-v<version>` because
`release.yml` runs on `v*.*.*`. Add the CHANGELOG entry for the version first.

Prefer the recipe over hand-editing the three version fields, which must stay identical.

## Writing prose

This applies to authored Markdown: agent and skill bodies, plan files, `docs/`, `README.md` and
this file. No hook, linter or test enforces it; review does.

### Voice

- Plain and technical. No personality, no jokes, no encouragement.
- No first person. Write about the system, not the writer.
- One idea per sentence. Prefer a short sentence over a qualified one.
- State the rule, then the reason.
- Docs enumerate and never count: list the agents, skills or hooks, and leave the number to a
  runtime query.
- A model-facing file (`agents/`, `skills/`, `templates/`, `output-styles/`, every `AGENTS.md`)
  states current behavior only. It never says what something used to do or which version
  changed it, because the model cannot know that history.

### Structure

- Imperative mood and present tense for instructions: "make the parser reject empty input", not
  "this change makes the parser reject empty input"
  ([Linux submitting-patches](https://www.kernel.org/doc/html/latest/process/submitting-patches.html)).
- Present tense for behavior: "the hook writes the state file"
  ([Google, tense](https://developers.google.com/style/tense)).
- A procedural step starts with a verb, does one thing, and names the place before the action:
  "In `hooks/hooks.json`, add the handler"
  ([Google, procedures](https://developers.google.com/style/procedures)).
- Sentence case for headings ([Google, headings](https://developers.google.com/style/headings)).
- A task description longer than two lines is two tasks, or padded.

### Banned phrasing

Each pattern below carries no information
([Wikipedia, signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)).
Delete it or replace it with a fact.

| Pattern | Example | Fix |
| --- | --- | --- |
| Trailing "-ing" justification | "..., ensuring maintainability" | Cut it, or state the benefit as its own sentence with a mechanism |
| Adjective triples | "clean, maintainable, and scalable" | Name the one property that matters |
| Negative parallelism | "not just X, but Y" | State Y |
| Puffery | "comprehensive", "robust", "seamless", "showcasing" | Delete, or give a measurable claim |
| Copula avoidance | "serves as", "stands as", "represents" | Use "is" |
| Inflated possession verbs | "features", "offers", "boasts" | Use "has" |
| Vague attribution | "best practices suggest" | Cite the source, or drop the rule |
| Em or en dash in prose | any | Use a period, comma, colon or parentheses |
| Emoji as structure | section markers, status glyphs | Use headings, lists or words |
| Excessive bold | whole sentences, every list lead | Bold only the term being defined |

A dash inside a table cell as a none or not-applicable marker stays.

### Preserve byte-identical

A prose pass leaves these alone, because each is read by the platform or by CI:

- YAML frontmatter in `agents/*.md` and `skills/*/SKILL.md`. A skill `description` is
  trigger-matched and character-capped.
- Headings other code greps for, such as `### Completion Signaling` in `agents/planner.md`,
  which `scripts/validate/agent-prompts.spec.ts` asserts. Grep before renaming a heading.
- Code blocks and output-format templates.
- Tool names, file paths and bracketed tokens such as `[VERIFICATION]`.

When a preserved string breaks a rule above, leave it and note the conflict.

## Writing comments

TypeScript in this repository gets no comment by default: names and types carry intent. A
comment holds a non-obvious why, an invariant, or the derivation of a measured constant, and
never names a plan, a task or a phase. The rules below also cover the code OMCA's agents write
in other projects; the plugin's `rules/` directory ships the per-language versions that the
context injector adds when an agent edits a matching file.

| Rule | Applies to | Source |
| --- | --- | --- |
| A comment that contradicts the code is worse than none; update it with the code | all | [PEP 8](https://peps.python.org/pep-0008/#comments) |
| Do not restate the line below | all | PEP 8, [Google Python](https://google.github.io/styleguide/pyguide.html), [kernel coding style](https://www.kernel.org/doc/html/latest/process/coding-style.html#commenting) |
| Say what the code does, not how; the code shows how | kernel C | kernel coding style, section 8 |
| Comment the tricky, non-obvious or important parts, not everything | all | [Google Shell](https://google.github.io/styleguide/shellguide.html) |
| Every public or exported API gets a doc comment | Go, Rust, Python, shell libraries | [Go doc comments](https://go.dev/doc/comment), [RFC 505](https://rust-lang.github.io/rfcs/0505-api-comment-conventions.html), [PEP 257](https://peps.python.org/pep-0257/), Google Shell |
| A doc comment does not repeat the signature | all | PEP 257, [kernel-doc](https://www.kernel.org/doc/html/latest/doc-guide/kernel-doc.html) |
| Failure modes are documented: `Return:`, `# Errors`, `# Panics` | kernel C, Rust, Python, Go | kernel-doc, [Rust API guidelines](https://rust-lang.github.io/api-guidelines/documentation.html) |
| Every `unsafe` block has a `// SAFETY:` comment, and safe code has none | Rust | [clippy](https://rust-lang.github.io/rust-clippy/master/index.html#undocumented_unsafe_blocks) |
| A `TODO` names an owner or a tracking reference | all | Google Shell, [Google C++](https://google.github.io/styleguide/cppguide.html) |
| Comments are not a changelog; git keeps the history | all | this project |
| Delete commented-out code | all | this project; no first-party guide requires it |
| Line comments are the norm; avoid block comments | Rust, Go | RFC 505, [Effective Go](https://go.dev/doc/effective_go#commentary) |
| A numeric constant whose name cannot explain it gets a one-line derivation comment, or `UNDOCUMENTED` when the reason is lost | shell | this project |

The kernel's rule reads "tell WHAT your code does, not HOW". It is often misquoted as "why, not
what", which is a different claim from a different author. Go's style guides have no `TODO`
section, so `TODO(owner)` in Go is standard-library practice rather than a written rule.

Stripping comments is not the goal. Ousterhout's *A Philosophy of Software Design* (chapters 12
and 13) flags a comment that repeats the code; it does not license removing the ones that carry
a contract.

### Protected comments

A cleanup pass, a lint autofix or the `remove-ai-slops` skill never removes:

1. License and SPDX headers.
2. File and module headers.
3. Crate, package and module docs: Rust `//!`, Go `// Package x`, Python module docstrings.
4. Public and exported API docs.
5. `// SAFETY:` justifications.
6. Locking, concurrency and `Context:` contracts: which locks are held, whether a call may sleep.
7. Non-obvious invariants, units and boundary conditions, such as an inclusive bound beside an
   exclusive one.
8. Error, panic and failure semantics: `Return:`, `# Errors`, `# Panics`.
9. Deprecation notices. Go's `Deprecated:` paragraphs are read by tooling.
10. Workaround rationale that links the upstream bug.
11. Complexity notes such as `O(n log n)`, which a caller relies on.
12. Comments a project mandates, such as the derivation comment above a numeric constant. Check
    for such a rule before any cleanup.
