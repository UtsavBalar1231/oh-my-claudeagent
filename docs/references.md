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
| `allowManagedHooksOnly` | Stops OMCA's settings hooks and its mod unless your organization installed the plugin. The stop checks, guidance and guard are then gone |
| `disableAllHooks` | Stops every hook and mod, OMCA's included |
| `allowManagedModsOnly` | An option on Claude Code's built-in guard. Stops OMCA's mod (band, pane, doctor, guard) and leaves its settings hooks running |
| `allowManagedPermissionRulesOnly` | Only managed permission rules apply. OMCA adds none, so nothing of OMCA's changes |
| `allowManagedMcpServersOnly` | Only managed MCP servers connect, which leaves out `omca`, `grep` and `context7` |
| `strictKnownMarketplaces`, `blockedMarketplaces` | Decide whether the `omca` marketplace can be added |
| `sandbox.failIfUnavailable` | Fails closed when the sandbox cannot start. OMCA does not depend on it either way |

`teammateMode: "auto"` is a normal baseline for agent teams. The `omca-setup` skill reports on
these keys and never writes them.

## Agents

Each agent declares a model tier and an effort level in its frontmatter. A tier alias resolves to
your provider's model for that family, so the roster never pins a model id. Spawn one with
`Agent(subagent_type="oh-my-claudeagent:<name>")` or mention it as
`@agent-oh-my-claudeagent:<name>`.

| Agent | Tier | Effort | Role | Limits |
| --- | --- | --- | --- | --- |
| sisyphus | opus | high | The main-session orchestrator. The plugin's `settings.json` makes it the session agent. It does small work itself and delegates the rest; under `start-work` it runs the plan | Runs at the session's effort as the main agent |
| prometheus | opus | high | Interviews you and writes the plan, consulting metis and momus. Its Socratic interview ends in research findings instead of a plan | No Bash |
| metis | opus | high | Gap analysis of a request or draft plan: hidden requirements, scope risks | Read-only, no Bash |
| momus | opus | high | Reviews a plan for clarity, verifiability and completeness; answers OKAY or REJECT | Read-only, no Bash |
| oracle | fable | xhigh | Architecture, trade-offs, and debugging that is already stuck | Read-only |
| explore | sonnet | high | Searches the local codebase | Read-only |
| librarian | sonnet | high | Library docs and open-source examples, through context7 and grep.app | Read-only |
| executor | sonnet | high | Implements one scoped task and verifies it before reporting | Does not delegate |
| hephaestus | opus | medium | Fixes build, type and toolchain failures with minimal diffs | Does not delegate |
| multimodal-looker | opus | medium | Reads images, PDFs and diagrams | Read-only |

Only sisyphus and prometheus can spawn further agents. `servers/categories.json` maps kinds of
work to tiers for delegation: `quick`, `standard` and `readonly` to `sonnet`, `deep` to `opus`,
`hardest` to `fable`.

The roster's tier and effort hold unless something overrides them: a `model` passed on one call,
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, which puts every agent on one model, or a `maxEffortLevel`
cap, which clamps every declared effort. The doctor reports the last two.

When you turn on the advisor (`/advisor fable`, or `/advisor opus` without Fable access), OMCA's
prompts consult it before a large plan, when an error repeats, and before calling a long task
done. With the advisor off, they escalate to oracle.

## Skills

| Skill | Run it with | What it does |
| --- | --- | --- |
| plan | `/oh-my-claudeagent:plan <task>` | prometheus planning, with metis and momus. Only you can start it |
| start-work | `/oh-my-claudeagent:start-work [plan] [--worktree <path>]` | Runs a plan in the main session, delegating each task. Only you can start it |
| metis | `/oh-my-claudeagent:metis` | Runs metis on a request or plan, in a forked context |
| momus | `/oh-my-claudeagent:momus <plan>` | Runs momus on a plan, in a forked context |
| hephaestus | `/oh-my-claudeagent:hephaestus` | Runs hephaestus on a failing build, in a forked context |
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
skill. Quoted or backticked text, pasted text, and prompts from subagents never trigger.

| Phrase | Points at |
| --- | --- |
| `create plan`, `run prometheus`, `prometheus plan` | plan |
| `run metis`, `metis analyze`, `pre-plan` | metis |
| `fix build`, `build broken`, `run hephaestus`, `hephaestus fix` | hephaestus |
| `setup omca`, `omca setup` | omca-setup |
| `handoff`, `context is getting long`, `start fresh session` | a suggestion to run `/oh-my-claudeagent:handoff` |

A slash command activates its mode whether or not the option is on.

## MCP tools

`.mcp.json` starts these servers: `omca` (bun, local), `grep` (grep.app code search, over HTTP)
and `context7` (library docs, over HTTP).

Only `evidence_log`, `boulder_progress` and `notepad_write` load with the first request. Every
other `omca` tool waits behind tool search and loads with
`ToolSearch` and the query `select:mcp__plugin_oh-my-claudeagent_omca__<tool>`. Where tool search
is off, for example behind a gateway that is not a first-party host, every tool loads up front.

| Tool | Purpose |
| --- | --- |
| `evidence_log` | Record a build, test, lint, manual or `final_verification` result with its real exit code |
| `evidence_read` | Read the logged entries |
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
| `health_check` | ast-grep, the state files, and whether this session's hooks and mod are running |

`omca_hook` serves the settings hooks below; the model does not call it.

## Hooks

OMCA's hooks run in the mod and in the server. The mod, `hooks/register.ts`, runs inside Claude Code. The
settings hooks in `hooks/hooks.json` are `mcp_tool` entries that call the `omca` server's
`omca_hook` tool, which dispatches through `servers/hooks/registry.ts`.

### Mod events

| Event | Feature |
| --- | --- |
| `tool.check` for Bash and PowerShell | The destructive-command guard and its review dialog |
| `session.start` | Registers `/omca` and `/omca-rate`, writes the session's mod marker, draws the band's first state, and writes a transcript line when the `omca` server is not connected, naming a missing bun or the server's error |
| `turn.start`, `turn.complete` | The turn footer (time, tokens, cost, an unlogged verification), the band and its buttons, the pane's refresh |
| `agent.spawn`, `turn.step` | The Agents tab, delegation records, and the `[omca-route effort=...]` hint on a delegation's first line |
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
its condition clears. `TaskCompleted` fires only where the task tools exist, which needs
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` on current models or agent teams.

Events OMCA leaves unregistered, and why:

| Event | Why |
| --- | --- |
| `PermissionRequest` | OMCA never allows, and this event also fires where a call that cannot prompt would be denied, so a handler could only turn a denial into a run. The guard's deny is on `tool.check` |
| `PreCompact`, `PostCompact` | The mod's `session.compact` feature shapes the summary, and the `SessionStart` compact handler restores context where the model can still see it |
| `SessionEnd` | Its 1.5 s budget can kill a write halfway. The server unbinds its sessions when it exits |
| `FileChanged` | The mod re-reads the evidence ledger and plan registry at each turn's end and on the open pane's timer |
| `StopFailure` | Claude Code discards a handler's output for it, so it cannot resume a plan |
| `Setup` | Claude Code runs no `mcp_tool` hook on it, and `/omca doctor` reports the same checks |
| `SubagentStop`, `TaskCreated`, `TeammateIdle`, `Notification`, `ConfigChange`, `CwdChanged`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `MessageDisplay`, `PostToolBatch`, `Elicitation`, `ElicitationResult` | No OMCA feature needs them |

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
| `OMCA_ASCII` | `1` draws the band, pane, footer and dialog with ASCII glyphs |
| `CLAUDE_STATUSLINE_NERD_FONT` | `0` draws the status line with ASCII glyphs |
| `OMCA_NATIVE_AGENTS_MD` | `1` stops the context injector from adding `AGENTS.md` where Claude Code already loads it natively and no project `CLAUDE.md` is on the path |
| `OMCA_TRANSCRIPTS_ROOT` | The directory `session_search` reads instead of `~/.claude/projects` |
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
| `guardMode` | `dialog` | `dialog` asks before a held command where a dialog can show. `deny` never asks: a held git command is refused and a deeper removal or a force push to another branch runs |
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
`.omca/rules/`. Outside the project it writes only what `omca-setup` writes: the status line
keys in `~/.claude/settings.json`, a backup of that file, and the status line launcher.

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
| `.omca/rules/*.md` | you | Project rules, injected by file name pattern |
| `~/.claude/omca/statusline.ts` | `omca-setup` | The status line launcher |

Write the registry, ledger and notepads only through the tools; no hook stops a direct edit, and
a broken file stops the gates that read it.

## Where each feature works

| Feature | Terminal | Desktop Code tab | `claude -p`, Agent SDK | VS Code chat panel | Managed-settings machine |
| --- | --- | --- | --- | --- | --- |
| Agents and skills | Yes | Yes | Yes | Yes | Yes |
| `omca` MCP tools | Yes | When bun is on the app's `PATH` | Yes | When bun is on the app's `PATH` | Unless `allowManagedMcpServersOnly` |
| Stop checks, guidance, context injection | Yes | When bun is on the app's `PATH` | Yes | When bun is on the app's `PATH` | Unless `allowManagedHooksOnly` or `disableAllHooks` |
| Guard decisions | Yes | Yes | Yes | Yes | Unless `allowManagedModsOnly`, `allowManagedHooksOnly` or `disableAllHooks` |
| Guard review dialog | Yes | Yes | No: held commands are decided without you | No: decided as in `-p` | As the guard |
| Band, pane, plan reader, doctor | Yes | Yes | No | No ([anthropics/claude-code#99045](https://github.com/anthropics/claude-code/issues/99045)) | As the guard |
| Status line | Yes | Not documented | No | Not documented | Unless `disableAllHooks` |

Where the built-in `sec-default` guard loads (a machine with managed settings, or a Team or
Enterprise sign-in), it runs ahead of OMCA's mod. OMCA's mod only denies, so the guard leaves its
decisions in place. A Desktop session in WSL loads no plugins.

## Platform support

CI runs the validator, the server specs, the type checks and the OpenCode adapter on Linux,
macOS and Windows against Claude Code 2.1.288. The guard reads Bash and PowerShell commands,
including `cmd /c` and `Invoke-Expression`, and resolves home and project paths per platform.
The README screenshots are captured with tmux, so capturing them needs Linux, macOS or WSL;
rendering them does not.

## Comparison with similar plugins

Measured on 2026-10-03 with Claude Code 2.1.287, OMCA at commit `bf5248f`, in Docker (Ubuntu
24.04, bun 1.4.2), every request answered by a local mock model with no network egress, over 20
paired rounds. The other arms were oh-my-claudecode 5.6.0, claude-code-harness 5.15.0, ruflo
3.51.1 (with and without its npm dependencies pre-seeded), ECC 2.2.3, superpowers 6.4.2, a
wshobson/agents bundle, and a baseline with no plugin.

Later changes have not been measured yet. Two of them cut OMCA's per-request tokens: the
sisyphus prompt is about 2,950 tokens shorter, and deferring every `omca` tool except
`evidence_log`, `boulder_progress` and `notepad_write` saves about 3,750. The guard now also holds
a force push to the default branch and `git commit --no-verify`, which the guard table predates.
A release now installs from a packaged branch without `package.json` or `bun.lock`, which removes
the install-time download described below. A session whose `omca` server did not start now says so
in the transcript, and the server says so when the mod is not running.

### Where OMCA is worse

- **Context per request.** OMCA adds the most of any arm: about 19,440 estimated tokens per
  request with tool search on (next: ECC, about 10,830). The parts: the sisyphus prompt in the
  system prompt (about 8,680), the `omca` tools (about 5,290), the guidance injected on the first
  prompt (about 2,170), the output style (about 1,470), the agent and skill listing (about 1,460)
  and the server instructions (about 540).
- **bun is required.** Every settings hook and every tool runs in one bun server. With bun
  hidden, a session had no OMCA tools, no injected guidance and no stop gate, and showed no
  error. The guard, which runs in the mod, still worked.
- **Install-time download.** Claude Code runs `bun install` on install because the plugin
  ships a `package.json` and `bun.lock`. Offline the plugin is 2.8 MiB; an online install grew
  it to 169.1 MiB. Only oh-my-claudecode ended larger.
- **Startup.** The first request came 190 ms after the baseline's: later than
  claude-code-harness (56 ms), superpowers and wshobson/agents (16 to 17 ms), level with
  oh-my-claudecode and pre-seeded ruflo, earlier than ECC and offline ruflo (over 2 s).
- **Network at start.** The bundled `grep` and `context7` servers try to reach mcp.grep.app and
  mcp.context7.com.
- **Files in the project.** A first session wrote 11 files under `.omca/` and `.claude/`, and a
  bun transpile cache under the home directory.

### Where OMCA is not worse

- **Per-call overhead.** 5.4 ms per Bash call and 5.0 ms per Read call over baseline, with 2.0
  process launches per Bash call against the baseline's 1.9. Only superpowers and
  wshobson/agents, which register almost no hooks, were lower.
- **Offline footprint.** 2.8 MiB in 299 files, smaller than claude-code-harness, ECC and
  oh-my-claudecode.
- **Stop gate.** OMCA was the only arm that continued a scripted stop with plan tasks unchecked.
- **Your files.** No arm, OMCA included, edited a `CLAUDE.md`, and OMCA wrote no settings beyond
  the entries Claude Code writes for every install.

### Measurements

| Arm | Tokens per request vs baseline, tool search on | First request vs baseline | Per Bash call vs baseline | Offline install |
| --- | --- | --- | --- | --- |
| OMCA | +19,438 | +190 ms | +5.4 ms | 2.8 MiB, 299 files |
| oh-my-claudecode | +3,567 | +181 ms | +99.3 ms | 67.5 MiB, 7,077 files |
| claude-code-harness | +2,381 | +56 ms | +23.4 ms | 78.3 MiB, 1,752 files |
| ruflo, pre-seeded | +5,034 | +194 ms | +277.1 ms | 440.9 KiB, 108 files |
| ruflo, offline | +780 | +2,131 ms | timed out | 440.9 KiB, 108 files |
| ECC | +10,832 | +2,156 ms | +73.3 ms | 55.0 MiB, 4,212 files |
| superpowers | +1,579 | +17 ms | -0.1 ms | 1.9 MiB, 229 files |
| wshobson/agents | +2,894 | +16 ms | +0.5 ms | 521.5 KiB, 85 files |

Guard corpus, one command per session under bypassPermissions, so only hooks can stop it:

| Arm | `rm -rf /` | `rm -rf ~` | `git reset --hard` | `git push --force origin main` | `git commit --no-verify` | `ls` |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | blocked by Claude Code | blocked by Claude Code | ran | ran | ran | ran |
| OMCA | blocked | blocked | blocked | ran | ran | ran |
| claude-code-harness | blocked | blocked | ran | blocked | blocked | ran |
| ECC | blocked | blocked | ran on retry | ran on retry | blocked | blocked |
| oh-my-claudecode, superpowers, wshobson/agents, ruflo | blocked by Claude Code or the plugin | blocked by Claude Code | ran | ran | ran | ran |

### Method

- **Tokens** are `ceil(characters / 4)` over each request body the mock received, split into
  system prompt, tools, listings, output style, server instructions and hook context, excluding
  the prompt text. Claude's tokenizer is not available offline, so these are estimates. Values
  are medians over the paired runs. The tool-search row sets `ENABLE_TOOL_SEARCH=true`, the
  closer match to first-party traffic.
- **Startup** is the time from process start to the mock's first request, as the median of the
  paired differences against baseline.
- **Per-call overhead** is the time from the first to the last request over 20 scripted `true`
  Bash calls (or 10 Read calls), divided by the call count, as the median paired difference.
  Process launches come from `strace -f -e trace=execve`.
- **Install footprint** is the plugin cache after a hermetic install from a directory
  marketplace; the online figure repeats the install once with network access.
- **Guard corpus** runs one Bash call per session under `--permission-mode bypassPermissions`
  and counts a command as run when its effect is observable.
- **Stop gate** writes a plan with two unchecked tasks, binds the session to it where the arm
  supports that, and ends the turn.

The harness is in `benchmarks/compare/`, which the plugin does not ship. Its results are not
committed.
