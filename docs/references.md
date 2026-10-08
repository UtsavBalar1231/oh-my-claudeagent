# oh-my-claudeagent reference

This page lists what OMCA ships and how to configure it. For step-by-step use, see the
[usage guide](usage.md).

## What OMCA owns

Claude Code owns plan mode, memory, the plugin format, permissions, sandboxing, subagents,
teams, `/loop`, `/schedule`, `/goal`, `/code-review` and `/doctor`. OMCA owns its agent and
skill prompts, the orchestration policy, the evidence discipline, the `omca` MCP server, its
hooks, its interface (band, pane, doctor, status line) and its state under `.omca/`.

A plan is an ordinary Claude Code plan file. OMCA resolves the plans directory the way Claude
Code does: the `plansDirectory` setting relative to the project when set, otherwise
`~/.claude/plans`, and an active plan-mode file over both.

Your settings stay the authority. OMCA's hooks never auto-allow a command: they deny, ask or
advise, and every allow comes from your permission rules. Managed settings sit above OMCA, and
OMCA neither writes nor overrides them:

| Key | What it does to OMCA |
| --- | --- |
| `allowManagedHooksOnly` | Stops OMCA's settings hooks and its mod unless your organization installed the plugin. The stop checks, guidance and guard are then gone, and Claude Code reads `statusLine` and `subagentStatusLine` from managed settings only, so OMCA's status lines stop too |
| `disableAllHooks` | Stops every hook and mod, OMCA's included |
| `allowManagedModsOnly` | An option on Claude Code's built-in guard. Stops OMCA's mod (band, pane, doctor, guard) and leaves its settings hooks running |
| `allowManagedPermissionRulesOnly` | Only managed permission rules apply. OMCA adds none, so nothing of OMCA's changes |
| `allowManagedMcpServersOnly` | Only managed MCP servers connect, which leaves out `omca`, `grep` and `context7` |
| `strictKnownMarketplaces`, `blockedMarketplaces` | Decide whether the `omca` marketplace can be added |
| `sandbox.failIfUnavailable` | Fails closed when the sandbox cannot start. OMCA does not depend on it either way |

`/omca doctor` reports `allowManagedModsOnly`, `disableAllHooks` and `allowManagedHooksOnly`.

## Agents

Each agent declares a model tier and an effort level in its frontmatter. A tier alias resolves to
your provider's model for that family, so the roster never pins a model id. Spawn one with
`Agent(subagent_type="oh-my-claudeagent:<name>")` or mention it as
`@agent-oh-my-claudeagent:<name>`.

| Agent | Tier | Effort | Role | Limits |
| --- | --- | --- | --- | --- |
| orchestrator | opus | high | The main-session orchestrator. The plugin's `settings.json` makes it the session agent. It does small work itself and delegates the rest; under `start-work` it runs the plan | Runs at the session's effort as the main agent |
| planner | opus | high | Interviews you and writes the plan, consulting analyzer and reviewer. Asked to help you understand or research a problem, it returns findings instead of a plan | No Bash |
| analyzer | opus | high | Gap analysis of a request or draft plan: hidden requirements, scope risks | Read-only, no Bash |
| reviewer | opus | high | Reviews a plan for clarity, verifiability and completeness; answers OKAY or REJECT | No Bash. Writes or edits a file only when asked to |
| architect | fable | xhigh | Architecture, trade-offs, and debugging that is already stuck | Read-only |
| explorer | sonnet | high | Searches the local codebase | Read-only |
| researcher | sonnet | high | Library docs and open-source examples, through context7 and grep.app | Read-only |
| executor | sonnet | high | Implements one scoped task and verifies it before reporting | Does not delegate |
| build-fixer | opus | medium | Fixes build, type and toolchain failures with minimal diffs | Does not delegate |
| viewer | opus | medium | Reads images, PDFs and diagrams | Read-only, no Bash |

Only orchestrator and planner can spawn further agents. `servers/categories.json` maps kinds of
work to tiers for delegation: `quick`, `standard` and `readonly` to `sonnet`, `deep` to `opus`,
`hardest` to `fable`.

The roster's tier and effort hold unless something overrides them: a `model` passed on one call,
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, which puts every agent on one model, or a `maxEffortLevel`
cap, which clamps every declared effort. The doctor reports the last two.

When you turn on the advisor (`/advisor fable`, or `/advisor opus` without Fable access), OMCA's
prompts consult it before a large plan, when an error repeats, and before calling a long task
done. With the advisor off, they escalate to architect.

## Skills

| Skill | Run it with | What it does |
| --- | --- | --- |
| plan | `/oh-my-claudeagent:plan <task>` | planner planning, with analyzer and reviewer. It writes the plan and leaves binding it to `start-work`. Only you can start it |
| start-work | `/oh-my-claudeagent:start-work [plan] [--worktree <path>]` | Runs a plan in the main session, delegating each task. Only you can start it |
| analyzer | `/oh-my-claudeagent:analyzer` | Runs analyzer on a request or plan, in a forked context |
| reviewer | `/oh-my-claudeagent:reviewer <plan>` | Runs reviewer on a plan, in a forked context |
| build-fixer | `/oh-my-claudeagent:build-fixer` | Runs build-fixer on a failing build, in a forked context |
| handoff | `/oh-my-claudeagent:handoff` | Writes a context block for a new session. Only you can start it |
| debugging | `/oh-my-claudeagent:debugging` | Reproduce, rank hypotheses, instrument, fix, verify |
| refactor | `/oh-my-claudeagent:refactor <target>` | Maps the code and its tests, plans, then refactors step by step |
| git-master | `/oh-my-claudeagent:git-master` | Atomic commits, rebase and squash, history search |
| remove-ai-slops | `/oh-my-claudeagent:remove-ai-slops` | Strips slop from changed files, keeping load-bearing checks |
| init-deep | `/oh-my-claudeagent:init-deep` | Writes `AGENTS.md` files for a codebase |
| github-triage | `/oh-my-claudeagent:github-triage` | Read-only triage of open issues and pull requests, one agent per item |
| consolidate-memory | `/oh-my-claudeagent:consolidate-memory` | Merges agent memories and notepad learnings |
| omca-setup | `/oh-my-claudeagent:omca-setup [--uninstall]` | Checks requirements and sets up the status line |

The mod adds its own commands: `/omca [plan [name or path] | stats | doctor]` opens the pane, and
`/omca-rate up|down [note]` rates the last turn.

### Keyword triggers

With the `enableKeywordTriggers` option on, these phrases in a prompt point the session at a
skill. Double-quoted or backticked text, pasted text, and background-agent notifications never
trigger.

| Phrase | Points at |
| --- | --- |
| `create plan`, `run planner` | plan |
| `run analyzer`, `analyze plan`, `pre-plan` | analyzer |
| `fix build`, `build broken`, `run build-fixer` | build-fixer |
| `setup omca`, `omca setup` | omca-setup |
| `handoff`, `context is getting long`, `start fresh session` | a suggestion to run `/oh-my-claudeagent:handoff` |

A slash command activates its mode whether or not the option is on.

## MCP tools

`.mcp.json` starts these servers: `omca` (bun, local), `grep` (grep.app code search, over HTTP)
and `context7` (library docs, over HTTP).

Only `evidence_log`, `boulder_progress` and `notepad_write` load with the first request. Every
other `omca` tool waits behind tool search and loads with `ToolSearch` and the query
`select:mcp__plugin_oh-my-claudeagent_omca__<tool>`. Where tool search is off, for example behind
a gateway that is not a first-party host, every tool loads up front.

| Tool | Purpose |
| --- | --- |
| `evidence_log` | Record a build, test, lint, manual or `final_verification` result with its real exit code |
| `evidence_read` | Read the logged entries. Refuses a ledger it cannot parse |
| `boulder_write` | Register a plan and bind this session to it |
| `boulder_progress` | Completed and remaining tasks of the bound plan, and the next one |
| `notepad_write` | Append to a plan notepad section: `learnings`, `issues`, `decisions` or `problems` |
| `notepad_read`, `notepad_list` | Read a section, or list plans and sections |
| `notepad_compact` | Rewrite one section shorter |
| `ast_search`, `ast_find_rule`, `ast_test_rule`, `ast_dump_tree` | Structural code search with ast-grep |
| `ast_replace` | Structural rewrite, with a dry run |
| `file_read` | Read a file outside the working directories, with paging. Refuses credential files |
| `session_search` | Search this project's earlier Claude Code transcripts |
| `agents_list`, `categories_list` | The agent roster and the category table |
| `agents_migrate` | Move agent memories and agent ids to the current names. A dry run by default; `apply` writes, and `merge_indexes` merges `MEMORY.md` files that collide |
| `health_check` | ast-grep, the state files, and whether this session's hooks and mod are running |

`omca_hook` serves the settings hooks below; the model does not call it.

## Hooks

OMCA's hooks run in the mod and in the server. The mod, `hooks/register.ts`, runs inside Claude
Code. The settings hooks in `hooks/hooks.json` are `mcp_tool` entries that call the `omca`
server's `omca_hook` tool, which dispatches through `servers/hooks/registry.ts`.

### Mod events

| Event | Feature |
| --- | --- |
| `tool.check` for Bash and PowerShell | The destructive-command guard and its review dialog |
| `session.start` | Registers `/omca` and `/omca-rate`, writes the session's mod marker, draws the band's first state, and writes a transcript line when the `omca` server is not connected, naming a missing bun or the server's error |
| `turn.start`, `turn.complete` | The turn footer (time, tokens, cost, an unlogged verification), the band and its buttons, the pane's refresh |
| `agent.spawn`, `turn.step` | The Agents tab and delegation records |
| `tool.call` | A subagent's tool calls, kept for its page on the Agents tab; a main-loop call passes through untouched |
| `session.compact` | Asks the summarizer to keep the bound plan and its next ten open tasks |
| `ui.render`, `ui.focus`, `ui.scroll`, `ui.close`, `prompt.edit`, `command.run` | The band, the pane and the commands |

`tool.check` runs before every Bash and PowerShell call in every permission mode and never
returns an allow, which would skip the auto-mode classifier.

### Settings hook events

| Event | Matcher | Handlers |
| --- | --- | --- |
| `SessionStart` | `clear`, `compact` | `session-start`: after a compaction, re-injects the guidance and the bound plan's next task; after `/clear`, hands the guidance to the next prompt |
| `UserPromptSubmit` | any | `mod-notice` (on the launch session's first prompt, a message when the mod is not running), `guidance` (first prompt: guidance, session id, bound plan, and the session title `OMCA: <plan>`), `keyword-detector` |
| `UserPromptExpansion` | any | `guidance`, `slash-mode-detector` |
| `SubagentStart` | any | `subagent-context`: protocol, date, output contract and plan context for each subagent |
| `PreToolUse` | `Write`, `Edit` | `plan-write-guard` (a plan file needs numbered checkboxes), `comment-gate` |
| `PostToolUse` | `Read`, `Write`, `Edit`, `Agent`, `SubagentHandback`, `Bash`, `PowerShell` | `verification-recorder`, `context-injector`, `plan-format-warn`, `empty-task-response` |
| `PostToolUseFailure` | any | `failure-recovery`: advice on a failed call, and a stuck-loop note from a tool's third failure in five minutes |
| `PermissionDenied` | any | `permission-coach`: lets Bash retry after an auto-mode classifier denial |
| `Stop` | any | `stop-gates`: plan continuation, final verification, drift guard, in that order |
| `TaskCompleted` | any | `task-completed`: refuses to complete a task while a recent verification is unlogged |

Each stop gate continues the turn at most five times in a session and gets that budget back once
its condition clears. `TaskCompleted` fires only where the task tools exist: by default on older
models up to Opus 4.7 and Sonnet 4.6, and on other models with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.

Events OMCA leaves unregistered, and why:

| Event | Why |
| --- | --- |
| `PermissionRequest` | OMCA never allows, and this event also fires where a call that cannot prompt would be denied, so a handler could only turn a denial into a run. The guard's deny is on `tool.check` |
| `PreCompact`, `PostCompact` | The mod's `session.compact` feature shapes the summary, and the `SessionStart` compact handler restores context where the model can still see it |
| `SessionEnd` | Its 1.5 s budget can kill a write halfway. The server unbinds its sessions when it exits |
| `FileChanged` | The mod re-reads the evidence ledger and plan registry at each turn's end and on the open pane's timer |
| `StopFailure` | Claude Code discards a handler's output for it, so it cannot resume a plan |
| `Setup` | Claude Code runs no `mcp_tool` hook on it, and `/omca doctor` reports the same checks |
| `SubagentStop`, `TaskCreated`, `TeammateIdle`, `Notification`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `MessageDisplay`, `PostToolBatch`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult` | No OMCA feature needs them |

### Kill switches

`OMCA_DISABLED_HOOKS` turns off features by name, separated by commas or spaces, for the
session. `all` or `*` turns off every one. Set it in the environment Claude Code starts with.

| Name | Turns off |
| --- | --- |
| `bash-guard` | The guard's review and its refusals. The catastrophic-removal deny stays |
| `stop-gates` | Every stop gate |
| `plan-continuation`, `final-verification`, `drift-guard` | One stop gate |
| `task-completed` | The task completion check |
| `verification-recorder` | Recording verification commands, which the band, footer and task check read |
| `context-injector` | `AGENTS.md`, `README.md` and rule injection when a file is read or edited |
| `comment-gate` | The comment check on writes |
| `plan-write-guard`, `plan-format-warn` | The plan checkbox refusal and warning |
| `empty-task-response` | The note on an empty or malformed agent report |
| `failure-recovery` | Advice after a failed tool call |
| `subagent-context` | The context each subagent gets at start |
| `permission-coach` | The retry after an auto-mode denial |
| `keyword-detector`, `slash-mode-detector` | Mode detection from prompts and slash commands |
| `mod-notice` | The message that the mod is not running |
| `session-start` | Context restore after compaction and `/clear` |
| `compact` | The plan note in compaction instructions |

### Other environment variables

| Variable | Effect |
| --- | --- |
| `OMCA_COMMENT_GATE` | `advise` (default) lets a write through with a note; `deny` blocks it; `off` skips the check |
| `OMCA_GLYPHS` | The glyph set of the pane, band, footer, dialog and status line: `nerd` (default, Nerd Font icons), `unicode` (no Nerd Font needed) or `ascii` (plain text) |
| `OMCA_NATIVE_AGENTS_MD` | `1` stops the context injector from adding `AGENTS.md` where Claude Code already loads it natively and no project `CLAUDE.md` is on the path |
| `OMCA_TRANSCRIPTS_ROOT` | The directory `session_search` reads instead of `~/.claude/projects` |
| `AST_GREP_BIN` | The ast-grep binary the `ast_*` tools run, looked up on `PATH`, before `ast-grep` and `sg` |
| `OMCA_HOOK_TRACE` | `1` appends every hook call to `.omca/state/hook-trace.jsonl` |
| `OMCA_SUBAGENT_STATUSLINE_DUMP` | A file to append each raw subagent status line payload to |

## Configuration

### Plugin options

Set them from `/plugin`, or in your user `~/.claude/settings.json` under
`pluginConfigs["oh-my-claudeagent@omca"].options`. Claude Code does not read `pluginConfigs` from
a project's `.claude/settings.json`.

| Option | Default | Effect |
| --- | --- | --- |
| `showBand` | `true` | `false` hides the band above the prompt |
| `guardMode` | `dialog` | `dialog` asks before a held command where a dialog can show. `deny` never asks: a held git command is refused, and any other recursive removal or a force push to another branch runs |
| `enableKeywordTriggers` | `false` | `true` lets plain phrases point at a skill |
| `statuslineMode` | `on` | `off` makes `omca-setup` leave your status lines alone |
| `disableForceOrchestrationStyle` | `false` | `true` makes `omca-setup` remove `force-for-plugin` from the installed `output-styles/omca-default.md`, so your own `outputStyle` applies. Run setup again after each update |

```json
{
  "pluginConfigs": {
    "oh-my-claudeagent@omca": {
      "options": { "guardMode": "dialog", "showBand": true, "enableKeywordTriggers": false }
    }
  }
}
```

### Settings worth setting yourself

The plugin applies none of these.

| Setting | Suggestion |
| --- | --- |
| Allow rules such as `Bash(bun run *)` | Add them, or run `/fewer-permission-prompts`, to stop prompts for commands you trust |
| `worktree.baseRef` | `"head"` lets worktree agents see your unpushed commits |
| `askUserQuestionTimeout` | Leave it at `never`. A timed-out question silently answers a planning question with its default |
| `advisorModel` | Set it with `/advisor fable` (or `opus`). Telemetry opt-outs and `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` keep it off |
| `availableModels` | An allowlist must include `sonnet`, `opus` and `fable`, or the agents on a missing tier cannot run |
| `permissions.deny` with `Agent(model:fable)` | Gates per-call escalations to the `fable` tier. It cannot cap an agent's declared tier, because those calls carry no `model` |
| `subagentPromptCacheTtl` | `"1h"` keeps a long parallel run's cache warm, at a higher write price |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Default 10. A wider parallel group runs in series |

Do not add `Write(<path>)`, `NotebookEdit(<path>)` or `Glob(<path>)` rules: they never match.
`Edit(<path>)` covers every file-editing tool.

## State files

OMCA keeps its state in the project's `.omca/` directory, which it gitignores except for
`.omca/rules/`. Outside the project it writes:

- through `omca-setup`, the status line keys in `~/.claude/settings.json`, a backup of that file
  as `settings.json.omca-bak`, and the status line launcher;
- through the Doctor tab's `i` fix, `refreshInterval` in the same `settings.json`, with the same
  backup;
- through `omca-setup` with `disableForceOrchestrationStyle` on, the installed copy of
  `output-styles/omca-default.md` in the plugin cache;
- through bun, its transpile cache under your home directory.

| Path | Written by | Holds |
| --- | --- | --- |
| `.omca/state/boulder.json` | `boulder_write` | The plan registry: each plan, and which session is bound to which plan |
| `.omca/evidence/verification-evidence.json` | `evidence_log` | The append-only evidence log. Older entries move to a monthly archive file when it grows past 1 MiB or 1,000 entries |
| `.omca/notepads/<plan>/<section>.md` | `notepad_write`, `notepad_compact` | Plan notepads |
| `.omca/state/session/<session id>.json` | the server | The last hook call and the last verification command |
| `.omca/state/mod/<session id>.json` | the mod | Proof the mod ran this session, and its options |
| `.omca/feedback/<session id>.json` | `/omca-rate` | Ratings |
| `.omca/metrics/<session id>/<agent id>.json` | the mod | One record per delegation, read by the Stats tab |
| `.omca/logs/file-access.jsonl` | `file_read` | One line per call |
| `.omca/state/hook-trace.jsonl` | the server, with `OMCA_HOOK_TRACE=1` | One line per hook call |
| `.omca/rules/*.md` | you | Project rules, injected by file name pattern |
| `~/.claude/omca/statusline.ts` | `omca-setup` | The status line launcher |

Write the registry, ledger and notepads only through the tools; no hook stops a direct edit, and
a broken file stops the gates that read it. [File formats](formats.md) specifies plan files, the
ledger, notepads and the registry, and links the JSON Schemas for the ledger and the registry.

## Where each feature works

| Feature | Terminal | Desktop Code tab | `claude -p`, Agent SDK | VS Code chat panel | Managed-settings machine |
| --- | --- | --- | --- | --- | --- |
| Agents, and skills other than `plan` and `start-work` | Yes | Yes | Yes | Yes | Yes |
| `plan` and `start-work`, which stop unless `health_check` reports the runtime `ok` | Yes | When bun is on the app's `PATH` | Yes | When bun is on the app's `PATH` | Unless `allowManagedMcpServersOnly`, `allowManagedHooksOnly`, `disableAllHooks` or `allowManagedModsOnly` |
| `omca` MCP tools | Yes | When bun is on the app's `PATH` | Yes | When bun is on the app's `PATH` | Unless `allowManagedMcpServersOnly` |
| Stop checks, guidance, context injection | Yes | When bun is on the app's `PATH` | Yes | When bun is on the app's `PATH` | Unless `allowManagedHooksOnly` or `disableAllHooks` |
| Guard decisions | Yes | When the app's Claude Code is 2.1.292 or later | Yes | Yes | Unless `allowManagedModsOnly`, `allowManagedHooksOnly` or `disableAllHooks` |
| Guard review dialog | Yes | As guard decisions | No: held commands are decided without you | No: decided as in `-p` | As the guard |
| Band, pane, plan reader, doctor | Yes | As guard decisions, with [Desktop's differences](usage.md#desktop-and-vs-code) | No | No ([anthropics/claude-code#99045](https://github.com/anthropics/claude-code/issues/99045)) | As the guard |
| Status line | Yes | Not documented | No | Not documented | Unless `allowManagedHooksOnly` or `disableAllHooks` |

Where the built-in `sec-default` guard loads (a machine whose managed settings set at least one
key, or a Team or Enterprise sign-in), it runs ahead of OMCA's mod. OMCA's mod only denies, so
the guard leaves its decisions in place. A Desktop session in WSL loads no plugins.

## Platform support

CI runs the validator, the lint, the type checks, the bun specs, the mod tests, a smoke session
and the OpenCode adapter specs on Linux, macOS and Windows against Claude Code 2.1.292. The
guard reads Bash and PowerShell commands, including `cmd /c` and `Invoke-Expression`, and
resolves home and project paths per platform. The README screenshots are captured with tmux,
kitty and Xvfb, so capturing them needs Linux or WSL.

## Comparison with similar plugins

Measured on 2026-10-03 with Claude Code 2.1.288, read from the recorded request bodies, and OMCA
at commit `1061e97`. The run used Docker (Ubuntu 24.04, node 22.23.3, bun 1.4.2), answered every
request from a local mock model with no network egress, and took 20 paired rounds after one
discarded warm-up round. The other arms were oh-my-claudecode 5.6.0, claude-code-harness 5.15.0,
ruflo 3.51.1 (with and without its npm dependencies pre-seeded), ECC 2.2.3, superpowers 6.4.2, a
wshobson/agents bundle, and a baseline with no plugin.

Each comparison is against the other plugin arms. A point sits under "worse" when more of them
do better than OMCA than do worse. An arm counts as about level when it is within 10 percent of
OMCA's value, and within 5 ms for times and 0.5 `execve` for process counts.

### Where OMCA is worse

- **Context per request.** OMCA adds +16,307 estimated tokens per request in this harness, where
  tool search is off, and +12,679 with tool search on, the closer match to first-party traffic.
  With tool search on, every other plugin arm adds less. The largest addition of any arm is
  pre-seeded ruflo's +70,904 with tool search off, from its 358 MCP tools. OMCA's parts with tool
  search on, as medians that do not sum exactly: the orchestrator prompt in the system prompt
  (+5,676), the `omca` tools (+1,490, with 3 MCP tool schemas in the request and the deferred
  tools as names), the guidance injected on the first prompt (+2,194), the output style (+1,473),
  the agent and skill listing (+1,460) and the server instructions (+549). `claude plugin
  details` reports about 1,427 always-on tokens for OMCA, which counts only skill, agent and
  command names and descriptions.
- **Without bun.** Every settings hook and every tool runs in one bun server. With bun hidden,
  the first request carried no MCP tools and no hook context, and the stop gate did not continue
  a plan-bound session. In `claude -p`, the run showed no error. The guard, which runs in the
  mod, still blocked `rm -rf /` and `git reset --hard`.
- **Startup.** The first request came 248 ms after the baseline's. Five arms start earlier:
  claude-code-harness (+56 ms), superpowers (+11 ms), wshobson/agents (+17 ms),
  oh-my-claudecode (+188 ms) and pre-seeded ruflo (+192 ms). ECC and offline ruflo start later,
  over 2 s after the baseline. Claude Code waits for MCP servers to connect before the first
  request, so the bun server is part of this.
- **Network at session start.** A session tried to reach mcp.context7.com and mcp.grep.app, for
  the bundled `context7` and `grep` servers, which the closed network refuses.
- **Writes.** A first session wrote 11 paths into the project, 8 under `.omca/` and 3 under
  `.claude/`. It also wrote 28 paths under `~/.bun` and `~/.cache` beyond what the baseline
  writes. By the project count, six arms wrote fewer and claude-code-harness wrote more.
- **Install footprint.** The offline install measured 2.9 MiB in 282 files, from the tree at
  commit `1061e97`. ruflo, superpowers and wshobson/agents are smaller, and oh-my-claudecode,
  claude-code-harness and ECC are larger. The shipped tree leaves out the specs and the
  contributor tooling, so it is smaller than the measured one.

### Where OMCA is not worse

- **Per-call overhead.** +5.8 ms per Bash call and +5.0 ms per Read call over baseline. Per Bash
  call, oh-my-claudecode, claude-code-harness, pre-seeded ruflo and ECC are slower, and
  superpowers and wshobson/agents, which register almost no hooks, are faster.
- **Guard.** OMCA blocked all five destructive commands, including `git reset --hard`, a force
  push to `main` and `git commit --no-verify`. claude-code-harness blocked four of the five (not
  `git reset --hard`). ECC blocked three outright and gated `git reset --hard` and the force push
  once, then ran them on retry. The other arms left what Claude Code's own check leaves: the two
  `rm -rf` commands blocked, the other three run.
- **Process churn.** 2.0 process launches per Bash call against the baseline's 1.9. That is about
  level with superpowers and wshobson/agents and lower than the other four arms. Every OMCA
  `hooks.json` handler is an `mcp_tool` call rather than a command.
- **Install.** The offline install took 206 ms, contacted no host and fetched no dependencies.
- **Your files.** No arm, OMCA included, edited a `CLAUDE.md`, and OMCA wrote no settings beyond
  the `settings.json` entry Claude Code writes for every install.

The stop gate is a separate note, not a comparison. Only OMCA's run was armed with plugin state,
a bound plan holding unchecked tasks, so the result says whether each arm stopped in an unarmed
state, not whose gate is better. OMCA's was the only scripted stop that was continued.

### Measurements

| Arm | Tokens per request vs baseline, tool search on | Tool search off | First request vs baseline | Per Bash call vs baseline | Per Read call vs baseline | Offline install |
| --- | --- | --- | --- | --- | --- | --- |
| OMCA | +12,679 | +16,307 | +248 ms | +5.8 ms | +5.0 ms | 2.9 MiB, 282 files (at `1061e97`) |
| oh-my-claudecode | +3,566 | +11,714 | +188 ms | +101.0 ms | +105.0 ms | 67.5 MiB, 7,077 files |
| claude-code-harness | +2,380 | +2,381 | +56 ms | +22.6 ms | +20.0 ms | 78.3 MiB, 1,752 files |
| ruflo, pre-seeded | +5,034 | +70,904 | +192 ms | +275.2 ms | +10.6 ms | 440.9 KiB, 108 files |
| ruflo, offline | +779 | +907 | +2,135 ms | timed out | +0.6 ms (2 runs) | 440.9 KiB, 108 files |
| ECC | +10,791 | +10,918 | +2,160 ms | +73.2 ms | +44.4 ms | 55.0 MiB, 4,212 files |
| superpowers | +1,578 | +1,579 | +11 ms | +0.0 ms | +0.7 ms | 1.9 MiB, 229 files |
| wshobson/agents | +2,894 | +2,894 | +17 ms | +0.6 ms | +1.0 ms | 521.5 KiB, 85 files |

Guard corpus, each command issued twice in a session under bypassPermissions, so only hooks can
stop it. Offline ruflo got one call per session under a 90 s limit.

| Arm | `rm -rf /` | `rm -rf ~` | `git reset --hard` | `git push --force origin main` | `git commit --no-verify` | `ls` |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | blocked by Claude Code | blocked by Claude Code | ran | ran | ran | ran |
| OMCA | blocked | blocked | blocked | blocked | blocked | ran |
| claude-code-harness | blocked | blocked | ran | blocked | blocked | ran |
| ECC | blocked | blocked | ran on retry | ran on retry | blocked | blocked, a mock artifact |
| oh-my-claudecode, superpowers, wshobson/agents, ruflo | blocked by Claude Code or the plugin | blocked by Claude Code | ran | ran | ran | ran |

ECC's gate asks the model to present facts and retry. The scripted mock retries without them,
which a real model would not do, so its blocked `ls` is an artifact of the harness.

The online install probe was not run for OMCA, because its offline install tried no registry
host. Offline, oh-my-claudecode's install tried the npm registry and reported success after
60,555 ms.

### Method

- **Tokens** are `ceil(characters / 4)` over each request body the mock received, split into
  system prompt, tools, listings, output style, server instructions and hook context, excluding
  the prompt text. Claude's tokenizer is not available offline, so these are estimates, and the
  ratios between arms are more reliable than the absolute values. Values are medians over the
  paired runs, and a delta is the difference of two medians. The tool-search column sets
  `ENABLE_TOOL_SEARCH=true` (3 rounds), the closer match to first-party traffic, where MCP tools
  are deferred; Claude Code turns tool search off when the API host is not first-party, as in
  this harness.
- **First request** is the time from process start to the mock's first request, as the median of
  the paired differences against baseline.
- **Per-call overhead** is the time from the first to the last main-thread request over 20
  scripted `true` Bash calls (or 10 Read calls), divided by the call count, as the median paired
  difference. Process launches come from `strace -f -e trace=execve`.
- **Install footprint** is the plugin cache after a hermetic install from a directory
  marketplace, with the network host list taken from `strace` on each install step.
- **Writes** are paths that appear in a snapshot of the home directory, the config directory and
  the project taken before and after the first session. The run did not record whether a new
  path is a file or a directory.
- **Guard corpus** runs one Bash command per session under `--permission-mode
  bypassPermissions`, and counts a command as run when its effect is observable. A gate that
  refuses once and lets the retry through shows as ran on retry.
- **Stop gate** writes a plan with two unchecked tasks, binds the session to it for OMCA only,
  and ends the turn.

The harness is in `benchmarks/compare/`, which the plugin does not ship. Its results are not
committed.
