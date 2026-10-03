# Using oh-my-claudeagent

This page walks through the tasks you do with OMCA. Every agent, tool, hook, option and state
file is listed in the [reference](references.md).

## Install and set up

### Install

Install the plugin with the commands in the [README](../README.md#install). OMCA needs Claude
Code 2.1.288 or later and bun 1.4.2 or later. `ast-grep` (or `sg`) is optional: without it the
`ast_*` tools return an error and everything else works.

### Run setup

Run `/oh-my-claudeagent:omca-setup` once after installing. It checks the Claude Code and bun
versions, looks for ast-grep, asks the `omca` server whether it is running, and then offers to
point your status line and subagent status line at OMCA's renderer. Before it changes
`~/.claude/settings.json` it prints the diff and asks; the previous file is kept as
`~/.claude/settings.json.omca-bak`. It writes nothing into any `CLAUDE.md`: the `omca` server
gives each session OMCA's guidance on its first prompt.

`/oh-my-claudeagent:omca-setup --uninstall` removes the status line entries and the launcher.
`--check` and `--doctor` send you to `/omca doctor`.

### Share it with a team

Add this to a project's `.claude/settings.json` so everyone who opens the repository in a local
session gets the plugin. Cloud sessions skip these settings; an organization distributes plugins
to them through server-managed settings.

```json
{
  "extraKnownMarketplaces": {
    "omca": { "source": { "source": "github", "repo": "UtsavBalar1231/oh-my-claudeagent" } }
  },
  "enabledPlugins": { "oh-my-claudeagent@omca": true }
}
```

For GitHub Enterprise Server, use `{ "source": "git", "url": "<clone URL>" }` as the source.

### Update and uninstall

To update, run `claude plugin update oh-my-claudeagent@omca`, or open the plugin on the
Installed tab of `/plugin` and choose Update now. Then restart Claude Code. The status line
launcher runs the renderer from the most recently updated install, so the status line needs no
second setup run. If you set `disableForceOrchestrationStyle`, run setup again after each update.

To remove OMCA, run `/oh-my-claudeagent:omca-setup --uninstall`, then
`/plugin uninstall oh-my-claudeagent@omca` and `/plugin marketplace remove omca`. Each project
keeps its `.omca/` directory until you delete it.

### Use it from OpenCode

The `opencode/` directory loads OMCA's specialists, skills, MCP server and guards into OpenCode
2.0.18. Add it to your OpenCode config from git:

```jsonc
{
  "plugins": [
    {
      "package": "oh-my-claudeagent@git+https://github.com/UtsavBalar1231/oh-my-claudeagent.git",
      "options": { "models": { "opus": "anthropic/claude-opus-5-5", "fable": "anthropic/claude-fable-5-1" } }
    }
  ]
}
```

To load a local checkout instead, list the path of its `opencode/` directory under `plugins`.

`options.models` maps OMCA's `opus`, `sonnet` and `fable` tiers to OpenCode model ids, in
`provider/model` form with an optional `#variant`. Without it, every `omca-*` subagent runs on
the parent session's model. To override one agent, set `agents.omca-<name>.model` in your own
config. The `ast_*` tools need ast-grep on `PATH`.

What OpenCode gets:

- Subagents `omca-explore`, `omca-oracle`, `omca-librarian`, `omca-multimodal-looker`,
  `omca-metis`, `omca-momus`, `omca-hephaestus` and `omca-executor`.
- Skills `omca-debugging`, `omca-remove-ai-slops`, `omca-refactor`, `omca-git-master` and
  `omca-handoff`, each slash-invocable. `/omca-handoff` is not offered to the model.
- Commands `/omca-metis`, `/omca-momus` and `/omca-hephaestus`, each asking the primary agent to
  launch that subagent.
- The `omca` server's evidence, notepad, AST, `boulder_progress` and `file_read` tools, named
  `omca_<tool>`. The adapter hides `boulder_write`, `session_search`, `agents_list`,
  `categories_list`, `health_check` and `omca_hook`.
- The destructive-command guard and the comment gate on model and user shell commands and on
  file edits. The comment gate blocks only with `OMCA_COMMENT_GATE=deny`. A blocked `!` command
  shows as a failed command; the reason goes to the OpenCode server log.
- OMCA's working discipline, injected into primary agents such as `build` and `plan`.

Every id carries the `omca-` prefix, so OpenCode's own `build`, `plan`, `general` and `explore`
are untouched. The adapter leaves out the sisyphus orchestrator, the prometheus planner, `plan`
and `start-work` with plan tracking, the stop gates and the status line.

## Plan and run work

### Make a plan

Run `/oh-my-claudeagent:plan <what you want done>`. The prometheus agent interviews you for what
the plan needs, consults metis for gaps, writes the plan, and has momus review it. The plan
lands in your plans directory: the `plansDirectory` setting when you set one, relative to the
project, and `~/.claude/plans` otherwise. Each task is a numbered checkbox, `- [ ] 1. ...`;
progress tracking counts only numbered boxes.

To research before planning, ask `/oh-my-claudeagent:plan` to help you understand or research
the problem. Prometheus interviews you and returns its findings with no plan file.

The plan skill writes the plan and does not bind the session to it. `start-work` registers the
plan and binds the session that runs it.

### Run it

Run `/oh-my-claudeagent:start-work`, or `/oh-my-claudeagent:start-work <plan file>` to pick a
plan. The session binds itself to the plan, hands each task to an executor agent (in parallel
where the plan allows it), records a verification for each task, and checks its box when the
task is done. Add `--worktree <path>` to have every task work in an existing git worktree.

To resume after an interruption, run `/oh-my-claudeagent:start-work` again. It continues from the
first unchecked task. `/loop` cannot run `start-work` for you, because only you can start it.

### What keeps a session honest

After any build, test, lint or typecheck command, the agent logs the result with
`evidence_log`. These checks run when a session tries to stop:

- **Plan continuation**: the bound plan still has unchecked tasks.
- **Final verification**: every task is checked, but no `final_verification` entry with exit
  code 0 matches the plan's current content.
- **Drift guard**: the last reply claims the work is done while a changed line still holds a
  stub marker.

Each one continues the turn with its reason. A check gives up after five continuations in a
session and gets its budget back once its condition clears, so a stuck check cannot trap a
session.

When the task tools are on, marking a task complete is also refused while a verification command
under an hour old has not been logged. Claude Code turns the task tools on by default only for
older models, up to Opus 4.7 and Sonnet 4.6; on other models set
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.

### Hand off a long session

When the context is long, run `/oh-my-claudeagent:handoff`. It gathers git state, the plan and
the notepad into a block you paste as the first message of a new session. Only you can start it;
the model cannot.

### Ask a specialist directly

Type `@agent-oh-my-claudeagent:<name>` to send a request to one agent, for example
`@agent-oh-my-claudeagent:oracle what is the right shape for this cache?`.

## The band, the pane and the plan board

### The band

The band sits above the prompt. It shows the bound plan's progress as a bar with its done and
total tasks, the next open task, how many tasks are proven, unproven and failed (see
[proof](#proof)), a verification command whose evidence was not logged, and how many agents are
running. As the window narrows it drops the verification first, then the proof counts, the next
task and the running count; the bar stays. The prompt's border names the plan.

Below it, numbered buttons offer the next step: log the evidence, start work, run the final
verification, or review the changes with oracle. Press a button's digit in an empty prompt, or
click it, to fill the prompt with that step; nothing runs until you send it. Typing anything else
clears the buttons.

Set the `showBand` option to `false` to hide it.

### The turn footer

After each main-session turn, OMCA prints one line with the turn's duration and its input and
output tokens. An account billed by the token also sees the turn's cost. When a verification
command ran during the turn and no evidence was logged after it, a warning naming the command
takes the cost's place.

### The pane

`/omca` opens the OMCA pane on its Agents tab. Each tab has a digit key:

1. **Agents**: a lane for each running subagent with its task, model, effort, tokens, elapsed
   time and a strip of its recent tool calls, one glyph per kind (read, edit, bash, MCP, agent).
   A finished agent shrinks to one line with the first line of its result and its duration.
   Point at a lane, or press `d`, to see its prompt and last output.
2. **Plan**: the plan board, below.
3. **Evidence**: the proof ledger, below.
4. **Notepad**: one card per section of the bound plan's notepad, each entry under its date. `f`
   finds text in the entries, `w` clears the search, and `l` picks another plan's notepad.
5. **Feedback**: your ratings for this session. `u` rates the last turn up and `d` rates it
   down.
6. **Stats**: runs and the evidence rate per agent type, tokens per finished delegation, and the
   estimated cost by agent, across the project's recorded sessions. Runs on a model without a
   known price are counted as excluded rather than estimated. `r` reloads the records.
7. **Doctor**: the checks described below.

`/omca plan`, `/omca stats` and `/omca doctor` open the pane on that tab. Press Ctrl+X then Tab,
or click the pane, to focus it. Esc, the close mark in the pane's corner, or Ctrl+X then X close
it. Every key letter below works only while its tab is shown.

The band and the pane draw every color from your Claude Code theme, so a custom theme in
`~/.claude/themes/` applies to them too. Each state also carries a glyph and a word, so nothing
depends on color alone. Secrets in commands, output and notes, such as API keys, tokens and
`password=` values, are drawn as `‹masked›`, and your home folder as `~`.

### The plan board

`/omca plan` opens the bound plan; `/omca plan <name or path>` opens another. A plan with
numbered tasks opens on its board: a header with the plan's status, a progress bar, the proof
counts, the next task and the running agents, then the tasks grouped by milestone. Each task row
shows whether it is done, in progress, open or blocked, its proof chip, the agent working on it,
and the tasks it waits for. A plan without numbered tasks opens on its sections.

A wide pane shows the focused task's detail beside the list, a narrower one under the task's
row, and Enter opens it as a page. The detail holds the task's steps, its done-when commands, its
dependencies with their state, its files with the time since each changed, and the evidence runs
that bear on it.

| Key | On the board | On a task page |
| --- | --- | --- |
| Up, Down | Move | Scroll |
| Enter | Open the task | |
| `n`, `p` | | Next or previous task |
| `k` | Fill the prompt to run the task's check | The same |
| `s` | Fill the prompt to start work from the task | The same |
| `c` | Copy the task | The same |
| `e` | Switch to the Evidence tab | The same |
| `o` | Show open tasks only | |
| `x` | Show failing tasks only | |
| `f` | Find tasks by their text | |
| `t` | The plan's sections | |
| `l` | Recent plans | |
| `b` | | Back to the board |
| Esc | Close the pane | Close the pane |

In the sections list Enter opens a section, `b` returns to the board, `r` reloads and `l` lists
recent plans. On a section, `n` and `p` step to the next or previous one, `r` reloads and `t`
returns to the list. The board reloads the file when it changes on disk and keeps your place.

#### Proof

A task's proof chip compares the files its `File:` line lists with the evidence log. The newest
test, build or lint run since any of those files last changed decides it: **PROVEN** when it
passed, **FAILED** when it failed, **UNPROVEN** when no such run has happened yet. A task that
lists no file, or whose files do not exist, gets no chip.

### The proof ledger

The Evidence tab opens on a verdict for the bound plan: **COMPLETE** when a passing final
verification matches the plan file as it is now, **STALE** when the plan changed after it passed,
and **MISSING** when none passed. A strip of dots shows the exit codes of the last 30 runs.

Below it the runs are grouped by day, newest first, each with its time, type, exit code, command
and the agent that logged it. Up and Down move the focus, and the focused run opens to show its
command and output.

| Key | Action |
| --- | --- |
| `b`, `t`, `l`, `m`, `v` | Show only build, test, lint, manual or final verification runs; again to show all |
| `x` | Show failed runs only |
| `f` | Find runs by their command |
| `c` | Copy the focused command as drawn, secrets masked |
| `r` | Fill the prompt to run the focused command again |

## The guard

OMCA's guard checks every Bash and PowerShell command before it runs, including commands handed
to another interpreter: `bash -c`, `sh -c`, `eval`, a heredoc fed to a shell, `pwsh -Command`,
`cmd /c` and `Invoke-Expression` with a literal string. It also sees through wrappers such as
`sudo`, `env`, `timeout`, `nice`, `nohup`, `stdbuf`, `ionice`, `chrt`, `setsid`, `time` and
`xargs`.

A recursive removal of the filesystem root, your home, the project or a folder directly under
root or home is always refused, in every permission mode.

A force push to the default branch and `git commit --no-verify` (or `-n`) are held for your
review, and refused wherever no dialog can show, in every permission mode including
bypassPermissions. The same goes for the git commands that discard work: `git reset --hard`,
`git stash`, `git clean`, `git restore`, a recursive `git rm`, and `git checkout` with a `--`
path. `git restore --staged` without `--worktree` touches only the index and runs. The guard
reads `rm` and git options wherever they stand, so `rm ~ -rf` and `git reset HEAD --hard` count.
The default branch is the one `origin/HEAD` names, or `main` and `master` when it names none,
read from local refs without a network call.

A force push to any other branch, any other recursive removal, and an `xargs rm -rf` whose
targets can't be known in advance are held for your review in an interactive session and allowed
to run where no dialog can be shown.

Set `OMCA_DISABLED_HOOKS=bash-guard` to turn off everything except the catastrophic-removal
check.

### The review dialog

The dialog shows the command and what it would touch: each removal target with its kind and
entry count, the uncommitted changes a hard reset discards, or the commits a force push drops
from the remote. Choose **Run it** to hand the command back to the normal permission checks.
**Refuse**, a dismissed dialog, or a failed one refuses it, and Claude is told not to retry.

The dialog shows in the terminal and the Desktop app. In `claude -p`, the Agent SDK and the VS
Code chat panel nothing can show it, so a held command is decided without you, as above.

### `guardMode`

The `guardMode` option is `dialog` by default. Set it to `deny` to skip the dialog everywhere:
the work-discarding git commands, a force push to the default branch and `--no-verify` are
refused, and a force push to another branch or any other recursive removal runs.

### Permissions

OMCA's hooks never auto-allow a command: they refuse, ask or advise, and an allow comes only
from the permission rules in your settings. To stop the prompts for package scripts you trust,
add allow rules such as `Bash(bun run *)` to your settings, or run `/fewer-permission-prompts`,
which proposes rules from your past sessions.

## The doctor

`/omca doctor` opens the Doctor tab and runs its checks:

- the OMCA version that is loaded, and whether Claude Code meets the 2.1.288 floor;
- whether bun 1.4.2 or later is on the session's `PATH`;
- when a hook last reached the `omca` server;
- whether `ast-grep` or `sg` is on `PATH`;
- the `showBand` and `guardMode` options;
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, which puts every agent on one model;
- a `maxEffortLevel` cap that holds agents below their declared effort;
- `allowManagedModsOnly`, `disableAllHooks` and `allowManagedHooksOnly`;
- which output style applies;
- whether the advisor can run, and which setting keeps it off when it cannot;
- the status line's `refreshInterval`.

Each row leads with OK, WARN, FAIL or INFO. Press `r` to run the checks again. When the status
line has no `refreshInterval`, press `i` to add `refreshInterval: 5`; the doctor shows the diff it
wrote and keeps a backup. A check with a known remedy offers a key that fills the prompt with it,
without sending: `m` for `/mcp`, `a` for `/advisor fable`, `y` for `/config` and `s` for
`/oh-my-claudeagent:omca-setup`.

## Rate a turn

`/omca-rate up` or `/omca-rate down` rates the last turn, with an optional note after the
verdict. With no note typed, the text you have selected becomes the note, cut to 200 characters,
and the reply says so. Ratings are kept in `.omca/feedback/<session id>.json` and listed in the
pane's Feedback tab.

## The status line

Once setup has configured it, the status line shows three rows, each on its own line: the
session (model and effort, vim mode, the active agent, and the bound plan's progress and next
task), the workspace (a context bar, git state, the project, the worktree and pull request, lines
changed and extra directories), and usage (the session's cost and duration, your usage limits and
a spend limit). A row too wide for the terminal wraps onto more lines. When the rows need more
lines than the terminal allows, segments give way one at a time across all three rows, least
useful first: extra directories, lines changed, the spend limit, the 7 day limit, the pull
request, the worktree, the vim mode, the agent, the directory, the 5 hour limit, the cost and
duration, the branch, the context bar, then the plan. The model always stays. No segment is cut
in half, and a terminal under 60 columns gets one compact line.

The usage limits appear for Claude.ai Pro and Max subscribers. The cost shows only when they are
absent and the cost is above zero, since a subscription is not billed by the token. Behind a
Claude apps gateway that reports only a spend limit, the cost shows, followed by the dollars spent
against that limit.

The subagent status line gives each running agent a row with its model, state, effort and
context use.

Set `CLAUDE_STATUSLINE_NERD_FONT=0` for ASCII glyphs. [`statusline/README.md`](../statusline/README.md)
has the layout rules.

## Project rules

A Markdown file in your project's `.omca/rules/` whose first line is `# pattern: <glob>` is
added to Claude's context the first time in a session that Claude reads, writes or edits a file
whose name matches the glob. Its body is capped at 1000 characters. OMCA ships comment rules for
Bash, Python, C and headers, Rust and Go, and a prose rule for Markdown. A file of the same name
in `.omca/rules/` replaces a shipped rule, and an empty one turns it off. OMCA keeps
`.omca/rules/` out of its own `.gitignore`, so you can commit your rules.

## Desktop and VS Code

Desktop and VS Code start `.mcp.json` with the GUI's `PATH`, which can lack `~/.bun/bin`. When
it does, the `omca` server never starts, and the MCP tools, the injected guidance and the stop
gates are off. At session start OMCA writes a line in the transcript that bun is not on `PATH`,
and the Doctor tab reports bun as missing. Make bun reachable from the app's `PATH`, for example
by linking it into a directory the app searches, and restart the app.

The VS Code chat panel runs OMCA's hooks but draws none of its interface: no band, no pane and
no guard dialog ([anthropics/claude-code#99045](https://github.com/anthropics/claude-code/issues/99045)).
The [availability table](references.md#where-each-feature-works) lists each feature by app.

## Troubleshooting

**The `omca` tools are missing.** At session start the mod asks Claude Code whether the `omca`
server connected, and when it did not, it writes one line in the transcript. Either bun is not on
`PATH`: install bun 1.4.2 or later and restart Claude Code (for Desktop and VS Code, see above).
Or the server failed: the line gives Claude Code's reason, and `/mcp` shows the server's state.
A server listed there as pending approval needs your approval.

**`evidence_log` fails partway through a plan.** The server was reconnecting or reloading. Call
the tool again; do not skip the evidence.

**The band, the pane and the guard are gone.** The mod is not running. On the first prompt of a
session the `omca` server shows a message once when that happens, saying the Bash guard, band and
pane are off. Run `/plugin` and check that OMCA is listed under mods active. Mods are off when
your organization sets `allowManagedModsOnly`, `allowManagedHooksOnly` or `disableAllHooks`, when
Anthropic turns them off remotely, or after the mod worker crashes three times. A session where
nothing draws, such as `claude -p` or the VS Code chat panel, runs the guard but shows no band or
pane. `OMCA_DISABLED_HOOKS=mod-notice` silences the message.

**`plan` or `start-work` stops before it starts.** Both skills call `health_check` first and
stop unless the runtime is `ok`, repeating its reason. `hooks_inactive` means no OMCA settings
hook reached the server in this session: `disableAllHooks` or `allowManagedHooksOnly` is set.
`mod_absent` means the mod has not marked the session since the last prompt: your organization
sets `allowManagedModsOnly`, the session started with `--safe-mode`, or the mod worker crashed.
When the tool itself is missing, the `omca` server is not connected; see the first entry above.

**Nothing from OMCA runs at all.** A session started with `--restricted` or
`CLAUDE_CODE_RESTRICTED=1` ignores user, project and local settings, so the plugin never loads.

**A plan run stopped with no message.** A turn that ends in an API error, such as a rate limit,
skips the stop checks. Resume with `/oh-my-claudeagent:start-work`.

**A worktree agent cannot see your latest commits.** New worktrees branch from
`origin/<default branch>` by default, so unpushed commits are missing. Set
`"worktree": { "baseRef": "head" }` in your user settings to branch from your local HEAD.

**A write under `.claude/` still prompts.** In the default and `acceptEdits` modes Claude Code
prompts for every write there, auto mode sends it to the classifier, and an `Edit(.claude/**)`
allow rule changes neither. To stop the prompt repeating, choose the option in it that allows
edits to the `.claude` folder for this session.

**Setup changed nothing and asked nothing.** Under the `dontAsk` permission mode, every write
that would prompt is denied instead. Run setup in a mode that can prompt.

**A hook change does not take effect.** Close the `/plugin` menu or start a new session; for a
`--plugin-dir` checkout, run `/reload-plugins`.

**The status line is hard to read with a screen reader.** `CLAUDE_STATUSLINE_NERD_FONT=0`
replaces the glyphs with text. The status line still writes color escapes.
