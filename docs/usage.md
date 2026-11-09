# Using oh-my-claudeagent

This page walks through the tasks you do with OMCA. Every agent, tool, hook, option and state
file is listed in the [reference](references.md).

## Install and set up

### Install

Install the plugin with the command in the [README](../README.md#install). OMCA needs Claude
Code 2.1.300 or later and bun 1.4.2 or later. `ast-grep` (or `sg`) is optional: without it the
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

`/oh-my-claudeagent:omca-setup --migrate` moves a project's agent memories, and the agent ids in
your user settings, to the current agent names. Run it in each project. It shows what it would
change, asks before it applies anything, and offers to merge `MEMORY.md` indexes when two
collide. `/omca doctor` warns while a project or your user settings still use names from the
rename table.

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

The adapter supports OpenCode 2.2.5 or later in the 2.x release line. Add the package to
`plugins` in `~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "oh-my-claudeagent@git+https://github.com/UtsavBalar1231/oh-my-claudeagent.git",
      "options": {
        "models": {
          "opus": "openai/gpt-6.1-sol#high",
          "sonnet": "openai/gpt-6.1-sol#high",
          "fable": "openai/gpt-6.1-sol#xhigh"
        }
      }
    }
  ]
}
```

For a local checkout, use its `opencode/` directory as the plugin path. Published
packages load their server and `./tui` exports together; do not add a second copy
to `cli.json`.

`options.models` maps OMCA's `opus`, `sonnet` and `fable` tiers to OpenCode model ids, in
`provider/model` form with an optional `#variant`. Without it, every `omca-*` subagent runs on
the parent session's model. To override one agent, set `agents.omca-<name>.model` in your own
config. The `ast_*` tools need ast-grep on `PATH`.

Choose `omca` from the primary-agent selector for coordination. Build and Plan
remain available. Specialists run as child sessions: `omca-explorer`,
`omca-architect`, `omca-researcher`, `omca-viewer`, `omca-analyzer`, `omca-reviewer`,
`omca-build-fixer` and `omca-executor`.
Read-only specialists use native read/search tools without shell or file edits.
With OMCA enabled, native Plan delegates only to Explore or OMCA's read-only
specialists. Execution-capable children require Build or OMCA. The OMCA coordinator
denies delegation to native General and Explore and routes work to its specialists.
Build retains access to General and Explore. Other custom delegation targets keep
their existing permissions.

Commands:

| Command | Behavior |
| --- | --- |
| `/omca` | Open the terminal panel without starting work |
| `/omca-plan <request>` | Discuss a plan in native Plan mode; save a file only when asked |
| `/omca-start-work [plan or instructions]` | Ask approval, then coordinate the open run or turn the plan into tasks and run them |
| `/omca-analyzer`, `/omca-reviewer`, `/omca-build-fixer` | Ask the primary agent to launch the specialist |

Use Build or OMCA before starting work. A plan is the conversation or a document in
any format, since nothing parses it. The coordinator turns it into tasks on the
checkout's task list, in `.omca/state/tasks/`, with the same run, final-task and
blocked-task rules as Claude Code's list. Every session in a checkout shares that
list, so a new session picks up an open run. Stopping is OpenCode's own interrupt;
the tasks stay. Each worktree has its own list. Only the OMCA coordinator changes the
list: Build, Plan and child agents can read it. List reads refuse a task file over
256 KiB or a list over 1,000 tasks. Dashboard snapshots refuse state files over 4 MiB
rather than allocating unbounded inputs.

The panel shows the current run, native child sessions, evidence, notepads and
adapter health. Selecting a child opens its native session. The interface uses
the current theme and leaves native tabs, the composer and permission prompts
in place. Headless clients use the same tools without the panel.

The adapter registers native `omca_*` evidence, notepad, AST, task and file
tools. It does not start a duplicate OMCA MCP process. Custom filesystem tools
still check native read/edit permissions; they do not bypass an external-directory
deny. The shell guard uses the actual command directory. The comment gate blocks
only with `OMCA_COMMENT_GATE=deny`.

**Limits:** OpenCode has no OMCA Stop veto, so nothing keeps a session working. A
run's final task does refuse to complete until a passing verdict names it, and refuses
to be deleted or closed as blocked until a verdict of any outcome names it. Completed
tasks and historical passing evidence do not prove the current checkout is verified.
The panel labels ledger successes as historical until native execution provenance is
supported. OpenCode's experimental `todowrite` list is separate from a run, and the
coordinator is not offered it.
The TUI is a terminal extension, not a Desktop or Web UI extension. OMCA does not
replace provider authentication, compaction, scheduling, memory, or native undo.

## Plan and run work

### Make a plan

Run `/oh-my-claudeagent:plan <what you want done>`. The planner agent interviews you for what
the plan needs, consults analyzer for gaps, writes the plan, and has reviewer review it. The plan
is a Markdown document that nothing parses, so its headings and prose are the planner's to choose.
It lands in your plans directory: the `plansDirectory` setting when you set one, relative to the
project, and `plans/` in the Claude config directory (`CLAUDE_CONFIG_DIR`, or `~/.claude`) otherwise. Ask for a project-local plan and it lands in
`.omca/plans` under the project instead. To make that the default, set
`plansDirectory: ".omca/plans"`. `.omca/` is gitignored, so those plans stay out of commits.

After the review the skill creates the run in Claude Code's task list, one task for each unit of
work. Every task of a run carries `metadata.run`, the run's name, and names the tasks it waits on
in `blockedBy`. The last task is the final verification and carries `metadata.final: true`. A task
that cannot be finished carries `metadata.blocked: "<why>"`, which closes it without completing
it, so it never counts as done and does not hold the run open.

To research before planning, ask `/oh-my-claudeagent:plan` to help you understand or research
the problem. Planner interviews you and returns its findings with no plan file and no tasks.

### Run it

A run lives in Claude Code's task list, not in the plan file. At session start OMCA sets
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and `CLAUDE_CODE_TASK_LIST_ID` when nothing has set them, with
one list for each checkout, so the tasks outlive `/clear` and a new session in the same checkout
can pick the run up with `/oh-my-claudeagent:start-work`. Set `CLAUDE_CODE_TASK_LIST_ID` yourself
to use another list.

Run `/oh-my-claudeagent:start-work`. The session reads the run's tasks, hands each open task to
an executor agent (in parallel where `blockedBy` allows it), records a verification for each,
and marks the task completed. With several open runs, add the run's name to pick one. Add
`--worktree <path>` to have every task work in an existing git worktree.

To resume after an interruption, or from a new session, run `/oh-my-claudeagent:start-work` again.
It continues from the first open task. `/loop` cannot run `start-work` for you, because only you
can start it.

### What keeps a session honest

After any build, test, lint or typecheck command, the agent logs the result with
`evidence_log`. These checks run when a session tries to stop:

- **Task continuation**: the run still has open tasks, the final task included.
- **Drift guard**: the last reply claims the work is done while a changed line still holds a
  stub marker.

Each one continues the turn with its reason. A check gives up after five continuations in a
session and gets its budget back once its condition clears, so a stuck check cannot trap a
session.

Marking a task complete is also refused while a verification command under an hour old has not
been logged, and the run's final task cannot close until
`evidence_log(evidence_type="final_verification", ..., exit_code=0, task_id="<id>")` is logged for
it. `evidence_log` records the task's run and list with the verdict, so a verdict for task `#3` of
one list never closes task `#3` of another.

### Hand off a long session

When the context is long, run `/oh-my-claudeagent:handoff`. It gathers git state, the open tasks and
the notepad into a block you paste as the first message of a new session. Only you can start it;
the model cannot.

### After compaction

Skills can go missing from the model's list after the conversation compacts. Run `/reload-skills`
to send the full skill list again. Claude Code also compacts a long conversation on its own after
about an hour idle, in the terminal, the Desktop app and VS Code (`idleCompaction`; see
`docs/references.md` for the settings).

### Ask a specialist directly

Type `@agent-oh-my-claudeagent:<name>` to send a request to one agent, for example
`@agent-oh-my-claudeagent:architect what is the right shape for this cache?`.

## The transcript, the band and the pane

### In the transcript

On a terminal OMCA redraws Claude Code's own transcript rows, so what it tracks shows up where
the work happens:

- **The turn line.** The dim line that closes each main turn (`✻ Cooked for 21s`) also carries the
  turn's input and output tokens, its cost on an account billed by the token, and a receipt for a
  verification command the turn ran: `✓ just test logged`, or `! just test not logged` when no
  evidence was logged after it. While background agents are still working it names them in
  their colors, as in `Waiting for executor, architect`. As the window narrows the line drops the
  clock, then the cost, then the tokens; the receipt stays.
- **An agent's launch.** The row of a single Agent call shows the agent's icon and name in its
  color and its task, with `background` flush right when it runs on its own, in place of
  `oh-my-claudeagent:executor(…)`. Several agents launched together keep Claude Code's own block.
- **A finished agent.** Claude Code's `Agent "…" finished` row becomes the agent's status mark,
  its name in its color and its task, with its duration, tool calls and tokens flush right, and
  the first line of its reply beneath. A failed or stopped agent says so in the theme's error or warning color. Press
  `ctrl+o` for Claude Code's full notification.
- **A verification run.** Under a folded group of shell commands, each test, build or lint run
  gets one row with its result: `✓ just test · 12 pass, 0 fail`, or `✗ just lint · exit 1 · 1
  problem (1 error)`, read from the command's own output. The runners are the ones the
  verification gate records.
- **A picture Claude reads.** Under a folded group with a Read of a PNG, a row names the file and
  its size, and a terminal that draws pictures (kitty, Ghostty, iTerm2 3.5 or later in fullscreen
  rendering) shows the picture beneath it, at most 72 columns by 20 rows. A terminal that cannot
  keeps the name row alone: OMCA asks the terminal once, after the first picture it draws. Inside
  tmux 3.3 or later, pictures draw once tmux's `allow-passthrough` and `focus-events` are on, and
  OMCA says so in the transcript when tmux holds them back. A group of more than three pictures
  previews three and names the rest, and the pictures in one group share 2 MiB: past that, and in
  tmux and iTerm2, a picture drawn from its file keeps the name row alone.
- **A turn that changed a run.** Claude Code draws nothing for its task tools, so under the turn
  line of a turn that created or updated a run's tasks OMCA adds one row: the run's name, done of
  total, then only that turn's changes, each with its mark: `+26 tasks`, `✓ #5` completed,
  `◐ #6 #7` started, `⊗ #8 blocked` closed as blocked and `◆ final done`, then `/tasklist`. A list
  names three ids, then how many more. As the window narrows, whole parts leave from the end; the
  run's name and the ids are never cut. A subagent's turn adds no row.
Running agents are listed by Claude Code itself, under the prompt. A session without a terminal
gets the turn's figures as one text row beneath the answer instead.

### The band

The band sits above the prompt. It shows a verification command whose evidence was not logged,
and a line when the session status file cannot be read. While a run has open tasks, a line under
it names the run with a short progress bar, done of total, the running tasks and how many were
closed as blocked, as in `◆ dotman-rewrite ━━━━────────── 5/27 · ◐ #6 #7 · ⊗ 1`. As the band
narrows, that line drops the bar, then the running tasks, then the blocked count. With none of
these, the band draws nothing.

Below them, numbered buttons offer the next steps: log the evidence, which stays first, and open the
task list while a run is open. Press a button's digit in an empty prompt, or click it, to fill the
prompt with that step; nothing runs until you send it. Typing anything else clears the buttons, and
so does filling the prompt from history, an undo or another plugin. The buttons are held while an
agent's transcript is in the main view and return with the main conversation.

Claude Code has one band for every mod, and a band another mod draws stays beneath OMCA's rows.
Set the `showBand` option to `false` to hide OMCA's.

### The pane

`/omca` opens the OMCA pane on its Agents tab. Each tab has a digit key:

1. **Agents**: a lane for each running subagent. When the pane has room for every one, a lane
   opens with the agent's mini mascot beside four rows: its name, state and elapsed time; its
   task; the tool it runs now and how many tool calls it has made; and its model, effort, tokens
   and cost, with a blank row before the next lane. Under a Finished label, the latest wave's
   finished agents keep their lanes while the rows allow, each mascot smiling or sweating beside
   the first line of its result, and older finished agents shrink to one line with their task,
   their result where room is left, and their duration. In a shorter pane each lane takes two rows
   and no mascot: the agent's icon, name, task, model, effort and elapsed time, then its tool and
   call count, with a blank row between lanes while the rows allow. The key row counts the running and
   finished agents and the tokens they spent. Point at a lane, or press `d`, to see its prompt,
   last output, tool calls and tokens. Press Enter on a lane, or click its name, to open the
   agent's page: its full brief, each tool call with its outcome and duration, its latest reply and its
   cost, shown as `~$` because it is estimated. On the page `b` goes back, `c` copies the brief,
   `r` reads the page again and `v` shows the agent's transcript in the main view; while that
   transcript is in view the same key reads Back to main. A teammate in a team has a lane too; it
   waits between messages instead of finishing. When the lanes run past the pane, a cue above and
   below counts the lanes out of view, the mouse wheel scrolls them, and Up and Down step the
   focus a lane at a time with the lanes following.

   The brief and the reply on the agent page are drawn as markdown and scroll a row at a time,
   and a shell command, on the page and in a lane's tool row, is highlighted as code.
   The one-line results,
   prompts and outputs in the lanes, the details rows and the card keep their markdown styles:
   code in the code color, bold, italics and links, with the markers dropped.
2. **Evidence**: the proof ledger, below.
3. **Notepad**: one row per section of a run's notepad (learnings, issues, decisions and
   problems), each with its entry count and the date of its newest entry. Enter or a click on a
   row opens that section's page, every entry under its date, which the mouse wheel scrolls a
   row at a time; `b` goes back to the rows. `f` finds text in the entries on either view, `w`
   clears the search, and `l` picks another plan's notepad from the rows.
Two pages have no digit key. `/omca stats` and `/omca doctor` open them, the tab bar names the
one shown after the tabs, and a digit goes back to a tab:

- **Stats**: runs per agent type, the evidence rate of executor and build-fixer, the agents that
  run checks, tokens per finished delegation, and the estimated cost by agent, across the
  project's recorded sessions. Runs on a model without a
  known price are counted as excluded rather than estimated. `r` reloads the records.
- **Doctor**: the checks described below.

As you type, the prompt's typeahead offers the `/omca` subcommands. Press Ctrl+X then Tab,
or click the pane, to focus it. Esc, the close mark in the pane's corner, or Ctrl+X then X close
it. Every key letter below works only while its tab is shown and its key is drawn.

Each tab fits the pane it gets. A short pane keeps the tab's header, any filter, at least one row
of content with a cue above or below it, and the keys; spare rows go to wrapped text and the
keys. When the tab labels do not fit on one row, the tabs other than the shown one show their
initial. A wide terminal gives the docked pane up to 120 columns while the transcript keeps 100.

The pane opens only when you ask for it; the transcript reports each agent as it finishes.

A toast appears when a verification fails and when a run completes.

#### Mascots

Each agent has a mascot. On the Agents tab a lane opens with its agent's mini, the full-size
figure's face and tool at 15 by 8 pixels, while the agent runs and after it finishes until the next wave starts, and the agent page shows the
full-size mascot in its header. A mascot moves only while its
agent works, smiles when the agent finishes, sweats when it fails and dozes while the agent waits. The terminal draws them in half-block characters and Desktop draws a still SVG.
`OMCA_GLYPHS=ascii` draws none. With Claude Code's `prefersReducedMotion` setting on, the mascots hold
still: a working mascot shows its first frame and Desktop draws a single frame.

A fork is a copy of the agent that started it, so its lane wears that agent's mascot and color
under the name `fork`, with a fork icon in place of the agent's own. A fork of the main
conversation wears the main agent's, which is the orchestrator unless your `agent` setting names
another; with no main agent set, a fork draws no mascot.

The transcript rows, the band and the pane draw every color from your Claude Code theme, so a custom theme in
`~/.claude/themes/` applies to them too. Each state also carries a glyph, and a word where the
row has room for it beside the agent's name, so nothing depends on color alone. Secrets in
commands, output and notes, such as API keys, tokens, `password=` values and the password in a
URL like `postgres://user:pass@host`, are drawn as `‹masked›`, and your home folder as `~`.

### The Tasks pane

`/tasklist` opens the Tasks pane, separate from the OMCA pane. It shows Claude's own task list,
the one Ctrl+T toggles under the prompt, whole. That checklist stops at five rows and drops
finished ones; the pane lists every task and updates while Claude works. Claude Code deletes a list
seconds after its last task completes, and the pane keeps the finished tasks until `/clear`.

The top of the pane names the run with work left and how many of its tasks are done, then a
progress bar and a count of each state. The tasks follow in the order the work runs, each section
under its own rule:

| Section | Mark | Holds |
| --- | --- | --- |
| Running | `◐` | Tasks in progress, with the agent that owns each |
| Ready | `○` | Tasks nothing holds back |
| Blocked | `⊗` | Tasks closed as blocked, with the reason on the row below |
| Waiting | `·` | Tasks that wait on another, with the first open one (`← #6 +1`) |
| Done | `✓` | Finished tasks, folded to one row with their count |

The final task carries `◆` and sits last in its section; while it waits, it shows how many tasks
are still open. Done opens by itself once nothing else is left. Other runs, and tasks that belong
to no run, fold to one row each under the open run; a click opens one. The marks follow
`OMCA_GLYPHS`, so the Nerd Font and ASCII tiers draw their own. When the pane is short, the blank
rows between sections go first, then the count row, and a list still too long scrolls under
`↑ n more` and `↓ n more`.

Enter or a click opens a task's page: its state and owner, the full reason a blocked task was given
up, the tasks it waits on and holds up, then its description and metadata. Each linked task is a
row you can open. The final task's page also shows the newest `final_verification` entry that names
it, passed or failed, with its exit code, time and first line of output.

| Key | Where | Action |
| --- | --- | --- |
| Up, Down | List | Move between tasks |
| Enter | List | Open the task's page |
| `d` | List | Show or hide the done tasks |
| `b` | Page | Back to the list, on that task's row |
| `n`, `p` | Page | The next or previous task, in list order |
| Up, Down, wheel | Page | Scroll the page |
| Esc | Both | Close the pane |

A subagent running in the background has no task tools, so only the main session and foreground
subagents change the list. Every agent can read it with OMCA's `task_list` and `task_get` tools. The
pane reads the session's list or the one `CLAUDE_CODE_TASK_LIST_ID` names; an agent team's shared list is not covered.

### The proof ledger

The Evidence tab opens on a checklist that says whether the newest build, test, lint and manual
run each passed.

Below it the runs are grouped by day, newest first, each with its outcome, time, type, command
and the agent that logged it. Up and Down move the focus, and the focused run opens to show its
command, output and exit code. In a wide pane it opens in a card beside the list, titled with
whether it passed, that shows the exit code, when it ran and who logged it, which task a final
verification closed, and the whole
command and output, wrapped rather than cut. When they run taller than the card, a cue on its
last row says so and the mouse wheel over the card scrolls it. The wheel over the list moves the
focus, and a click anywhere on a run's row focuses that run (on Desktop, a click on its time does).

| Key | Action |
| --- | --- |
| `t` | Step through the types the log holds, one at a time, then back to all |
| `x` | Show failed runs only |
| `f` | Find runs by their command |
| `c` | Copy the focused command as drawn, secrets masked |
| `r` | Fill the prompt to run the focused command again |

## The guard

OMCA's guard checks every Bash, PowerShell and Monitor command before it runs, including commands handed
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
from the remote. The command wraps onto up to four rows, and each list ends in `and N more` where
it would push the dialog past a 24-row terminal. Choose **Run it** to hand the command back to the
normal permission checks.
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
which proposes rules from your past sessions. An allow rule for an MCP server reaches only the
server it names, so allow all of OMCA's tools with `mcp__plugin_oh-my-claudeagent_omca__*`, the
server's whole normalized name followed by `__*`. A shorter prefix such as
`mcp__plugin_oh-my-claudeagent` matches nothing.

## The doctor

`/omca doctor` opens the Doctor page and runs its checks:

- the OMCA version that is loaded, and whether Claude Code meets the 2.1.300 floor;
- whether bun 1.4.2 or later is on the session's `PATH`;
- when a hook last reached the `omca` server;
- whether `ast-grep` or `sg` is on `PATH`;
- the `showBand` and `guardMode` options;
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, which puts every agent on one model;
- a `maxEffortLevel` cap that holds agents below their declared effort;
- `CLAUDE_CODE_EFFORT_LEVEL`, which sets one effort for every agent whatever it declares;
- two enabled copies of the plugin, of which only the one loaded first runs its hooks and mod;
- question auto-continue, from `CLAUDE_AFK_TIMEOUT_MS` or the `askUserQuestionTimeout` setting,
  which lets a plan interview settle on its defaults while you are away;
- `allowManagedModsOnly`, `disableAllHooks` and `allowManagedHooksOnly`;
- which output style applies;
- whether the advisor can run, and which setting keeps it off when it cannot;
- the status line's `refreshInterval`.

Each problem row leads with WARN, FAIL or INFO. The passing checks fold into one line that names
them; `o` shows their OK rows and hides them again, and each run folds them. Press `r` to run the
checks again. When the status
line has no `refreshInterval`, press `i` to add `refreshInterval: 5`; the doctor shows the diff it
wrote and keeps a backup. A check with a known remedy offers a key that fills the prompt with it,
without sending: `m` for `/mcp`, `a` for `/advisor fable`, `y` for `/config`, `s` for
`/oh-my-claudeagent:omca-setup` and `p` for `/plugin`.

## The status line

Once setup has configured it, the status line shows three rows, each on its own line: the
session (model and effort, vim mode and the active agent), the workspace (a context bar, git state, the project, the worktree and pull request, lines
changed and extra directories), and usage (the session's cost and duration, the prompt cache's
state and time left, your usage limits and a spend limit). A row too wide for the terminal wraps
onto more lines. When the rows need more lines than the terminal allows, segments give way one at
a time across all three rows, least useful first: extra directories, lines changed, the spend
limit, the 7 day limit, the cache state, the pull request, the worktree, the vim mode, the agent,
the directory, the 5 hour limit, the cost and duration, the branch, then the context bar. The model always
stays. No segment is cut in half, and a terminal under 60 columns gets one
compact line.

The usage limits appear for Claude.ai Pro, Max and Ultra subscribers. The cost shows only when they are
absent and the cost is above zero, since a subscription is not billed by the token. Behind a
Claude apps gateway that reports only a spend limit, the cost shows, followed by the dollars spent
against that limit.

The subagent status line gives each running agent a row with its model, state, effort and
context use.

The status line, the transcript rows and the `/omca` pane draw solid Nerd Font icons, and the
status line's cache and clock icons and its usage rings need Nerd Fonts v3. Set `OMCA_GLYPHS=unicode` when the terminal font has none or is an
older Nerd Font, or `OMCA_GLYPHS=ascii` for plain text; `/oh-my-claudeagent:omca-setup`
asks and writes it for you. [`statusline/README.md`](../statusline/README.md) has the layout rules.

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
keeps a warning under the prompt while the server is off, and the Doctor page reports bun as
missing. Make bun reachable from the app's `PATH`, for example
by linking it into a directory the app searches, and restart the app.

The Code tab in Desktop runs its own bundled copy of Claude Code. OMCA's mod
(the guard, transcript rows, band, pane, toasts and guard dialog) runs there only when that copy is 2.1.300 or
later; `/status` in a Code-tab session shows its version. On an older copy the agents, skills,
MCP tools and stop gates still work and the mod does not load. Desktop for Linux is a beta for
Debian and Ubuntu that updates through the package manager, so a newer bundled copy arrives with
the app's own update. When `/plugin` in a Desktop session does not list OMCA, name the plugin's
folder in `CLAUDE_CODE_PLUGIN_DIRS` ([anthropics/claude-code#94635](https://github.com/anthropics/claude-code/issues/94635)).

On Desktop the mod draws differently:

- A click on a run's time focuses it in the Evidence tab, since Desktop draws only a button's label.
- The pane docks on the right. `/omca` opens it, and it never opens on its own. Desktop can
  report `/omca` as not a command until the session's first reply, and runs it anyway
  ([#99691](https://github.com/anthropics/claude-code/issues/99691)). When Desktop does not place
  the pane, `/omca` replies with the reason.
- Mascots are still images: Desktop rebuilds every drawing on each change, which would restart an
  animation ([#99211](https://github.com/anthropics/claude-code/issues/99211)). The same rebuild
  can drop a click; click again.
- A button that fills the prompt, such as the band's Task list or the Evidence tab's Rerun, shows
  the text in a toast when Desktop's prompt box does not take it.
- The pane scrolls the way Desktop's own panes do, and each tab draws whole, with none of the
  terminal's scrolling windows inside it. The Evidence tab shows 40 runs at a time, with `n` and
  `o` for the newer and older ones. A view larger than Desktop draws at once shows a notice in its
  place; narrow it with Find, or read it in a terminal.
- `f` opens a Find field, but Desktop keeps the keyboard on the pane's buttons, so click the field
  before typing.
- Copy can report that the surface has no clipboard.
- The transcript keeps Desktop's own rows: Desktop draws its own turn footer, so the turn's
  figures and receipt arrive as a text row beneath the answer.

The VS Code chat panel runs OMCA's hooks but draws none of its interface: no band, no pane and
no guard dialog ([anthropics/claude-code#99045](https://github.com/anthropics/claude-code/issues/99045)).
The [availability table](references.md#where-each-feature-works) lists each feature by app.

## Troubleshooting

**The `omca` tools are missing.** At session start and at each turn the mod asks Claude Code
whether the `omca` server is connected. When it is not, at the start or because it stopped partway
through, the mod writes one line in the transcript and keeps a warning under the prompt, which it
clears on the first turn after the server connects.
Either bun is not on `PATH`: install bun 1.4.2 or later and restart Claude Code (for Desktop and
VS Code, see above). Or the server failed: the line gives Claude Code's reason, and `/mcp` shows
the server's state. A failed server is not started again on its own: choose Reconnect in `/mcp`,
and in `claude -p` runs Claude Code skips it for 15 minutes after a failed start. A server listed
there as pending approval needs your approval.

**`evidence_log` fails partway through a run.** The server was reconnecting or reloading. Call
the tool again; do not skip the evidence.

**The band, the pane and the guard are gone.** The mod is not running. On the first prompt of a
session the `omca` server shows a message once when that happens, saying the Bash guard, band and
pane are off. Run `/plugin` and check that OMCA is listed under mods active. The mod does not
load on a Claude Code older than 2.1.300. Mods are off when your organization sets
`allowManagedModsOnly`, `allowManagedHooksOnly` or `disableAllHooks`, when Anthropic turns them
off remotely, or after the mod worker crashes three times. Using Desktop can save that remote
switch as off in `~/.claude.json`, which then turns mods off in the terminal too; removing `cachedGrowthBookFeatures.tengu_plugin_hooks_modules` from that file and restarting
clears it ([#99130](https://github.com/anthropics/claude-code/issues/99130)). With two copies of
OMCA enabled from different marketplaces, only one copy's hooks and mod load, and `/plugin` notes
the other under Errors; disable one copy and run `/reload-plugins`. A session where nothing draws,
such as `claude -p` or the VS Code chat panel, runs the guard but shows no band or pane.
`OMCA_DISABLED_HOOKS=mod-notice` silences the message.

**`plan` or `start-work` stops before it starts.** Both skills call `health_check` first and
stop unless the runtime is `ok`, repeating its reason. `hooks_inactive` means no OMCA settings
hook reached the server in this session: `disableAllHooks` or `allowManagedHooksOnly` is set.
`mod_absent` means the mod has not marked the session since the last prompt: your organization
sets `allowManagedModsOnly`, the session started with `--safe-mode`, or the mod worker crashed.
`task_tools_absent` means Claude Code's task tools are off, and OMCA requires them. OMCA sets
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` at session start when nothing has set it, so something is keeping
them off: that variable set to another value, `CLAUDE_CODE_ENABLE_TASKS=0`, a deny rule on
`TaskCreate` or `TaskUpdate`, or a `--tools` list without them. `/omca doctor` names which.
When the tool itself is missing, the `omca` server is not connected; see the first entry above.

**Nothing from OMCA runs at all.** A session started with `--restricted` or
`CLAUDE_CODE_RESTRICTED=1` ignores user, project and local settings, so the plugin never loads.

**Installing or updating fails to clone from GitHub.** Without a GitHub SSH key, `claude plugin
install` retries over HTTPS, but an install or update from `/plugin` inside a session does not.
Set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` to clone over HTTPS everywhere.

**A run stopped with no message.** A turn that ends in an API error, such as a rate limit,
skips the stop checks. Resume with `/oh-my-claudeagent:start-work`.

**A turn ended with a safeguards refusal.** Claude Code continues a flagged turn once on its
own. When the turn still ends with `` Details: `[reasoning_extraction]` ``, OMCA sends one prompt,
marked as from the plugin, asking Claude to continue the task with conclusions, evidence and the
actions it took instead of its reasoning. It does so only for a turn you started in an
interactive session, never for its own prompt's turn, and not once you start typing. Other
refusals, such as a cybersecurity flag, are left to you: press Esc twice to rewind and rephrase,
or report a false positive with `/feedback`. `OMCA_DISABLED_HOOKS=refusal-recovery` turns the
follow-up off.

**A worktree agent cannot see your latest commits.** New worktrees branch from
`origin/<default branch>` by default, so unpushed commits are missing. Set
`"worktree": { "baseRef": "head" }` in your user settings to branch from your local HEAD.

**A write under `.claude/` still prompts.** In the default and `acceptEdits` modes Claude Code
prompts for every write there, auto mode sends it to the classifier, and an `Edit(.claude/**)`
allow rule changes neither. To stop the prompt repeating, choose the option in it that allows
edits to the `.claude` folder for this session.

**Setup changed nothing and asked nothing.** Under the `dontAsk` permission mode, every write
that would prompt is denied instead. Run setup in a mode that can prompt.

**A hook change does not take effect.** Close the `/plugin` menu or start a new session. In a
`--plugin-dir` session a saved mod file under `hooks/` reloads the mod by itself, while a change to
`hooks/hooks.json` or the server needs `/reload-plugins`.

**The status line is hard to read with a screen reader.** `OMCA_GLYPHS=ascii` replaces the
glyphs, bars and separators with plain text. The status line still writes color escapes.
