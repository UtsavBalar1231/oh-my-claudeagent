# oh-my-claudeagent

**Claude Code, with receipts.**

<img src=".github/assets/hero.png" width="1000" alt="A Claude Code session on the left hands task 7 of the checkout plan to the executor, while the OMCA pane on the right shows the plan board at 6 of 14 tasks, with proof on the done tasks, the executor on task 7 and task 7's detail beside the list.">

oh-my-claudeagent (OMCA) is a Claude Code plugin that plans work with you, hands each task to a
specialist agent, and keeps a session from calling work done before a verification has been
logged.

## Requirements

- Claude Code 2.1.288 or later. Tested with 2.1.288.
- bun 1.4.2 or later, on the `PATH` Claude Code starts with. The `omca` server, its hooks and
  the status line run on bun.
- `ast-grep` (or `sg`), optional. Only the structural code search tools need it.

CI runs on Linux, macOS and Windows.

## Install

```bash
claude plugin marketplace add UtsavBalar1231/oh-my-claudeagent
claude plugin install oh-my-claudeagent@omca
```

The marketplace installs from the `plugin` branch, a packaged tree with no `package.json` or
lockfile, so installing fetches no npm dependencies.

Inside a session, the same steps are `/plugin marketplace add UtsavBalar1231/oh-my-claudeagent`
and `/plugin install oh-my-claudeagent@omca`. Then run `/oh-my-claudeagent:omca-setup`, which
checks the requirements above and offers to point your status line at OMCA's renderer.

## Your first plan

1. Run `/oh-my-claudeagent:plan add rate limiting to the login endpoint`. The planner asks
   what it needs to know, has the plan reviewed, and writes it to your plans directory.
2. Run `/oh-my-claudeagent:start-work`. The session hands each task to an executor, records a
   verification after each one, and checks the plan's boxes as tasks finish.
3. Open `/omca` to watch the agents, the plan, the evidence and the notepad while it runs.

When the session tries to stop with tasks unchecked, or with every task checked and no final
verification logged, OMCA sends it back to work with the reason.

## What you see

The band above the prompt shows the bound plan's progress, the next open task, how many tasks are
proven, unproven and failed, a verification whose evidence was not logged, and how many agents
are running. The numbered buttons fill the prompt with the next step.

<img src=".github/assets/band.png" width="680" alt="The band above the prompt reads 6/14, next 7 Wire the order summary panel, 6 proven and 1 unproven, warns that the evidence for just test was not logged, and counts 1 running agent, with the button 1: Log evidence below it.">

`/omca plan` opens the plan board: the tasks grouped by milestone, each with its state, its proof
and the agent working on it. A wide pane shows the focused task's detail beside the list.

<img src=".github/assets/plan.png" width="680" alt="The Plan tab of the OMCA pane shows the checkout-redesign board at 6 of 14 tasks, with 6 proven, 1 unproven and 4 blocked. Tasks 1 to 6 are done and proven, the executor is on task 7, tasks 8, 9 and 11 are open, and the rest wait on other tasks. Beside the list, task 6, Build the payment step, shows its steps, its done-when command, its dependencies, its file changed 3h ago and the passing runs since then.">

The Evidence tab is the proof ledger: a verdict on the plan's final verification, then every
logged run grouped by day.

<img src=".github/assets/evidence.png" width="680" alt="The Evidence tab shows the final verification for checkout-redesign as MISSING, since the last one exited 1, with a line marking build, test, lint and manual as passing on their newest runs. Below it, fourteen runs are grouped under three days, each with its outcome, time, type and command. The focused run, a manual payment smoke test, is open beside the list with its exit code and its API key masked.">

The Agents tab gives each running subagent a lane with its task, model, effort and current tool
call, and shrinks a finished one to a line.

<img src=".github/assets/agents.png" width="680" alt="The Agents tab shows two running executors, one on Wire the order summary panel and one on Persist the draft order, each with its icon, model and effort, the watch command it is running and its count of tool calls, and one finished explore agent on a single line with the first line of its result.">

The guard holds a destructive shell command for your review and shows what it would touch.

<img src=".github/assets/guard.png" width="680" alt="A dialog headed OMCA guard says OMCA held rm -rf build for review, that it would remove the build directory with 4 entries, and offers Refuse or Run it.">

`/omca doctor` checks the client, bun, the server, ast-grep, the options and the settings that
change how OMCA runs. A check with a known fix offers a key that fills the prompt with it.

<img src=".github/assets/doctor.png" width="680" alt="The Doctor tab counts 1 warning, 1 info row and 11 passing checks. The warning says maxEffortLevel high holds oracle below the xhigh it declares, the info row offers a: Use /advisor fable, and the passing rows cover OMCA, Claude Code, bun, the omca server, ast-grep, the options, the agent models, the mod policy, the hooks, the output style and the status line.">

The status line shows the session (model, agent and the plan's next task), the workspace
(context window and git state) and usage (duration, usage limits, and cost for accounts billed
by the token) on rows of their own, and fits itself to the terminal's width. The subagent status
line gives each running agent a row.

<img src=".github/assets/statusline.png" width="900" alt="The OMCA status line under the prompt shows three rows: the model, effort and plan progress with the next task; a context bar, the git branch with change counts and the project; and the session cost and duration. Below it, one row for each of two running subagents shows its model, state and effort.">

In motion: `/omca plan` opens the board, Down moves the focus, Enter opens the task as a page,
and the number keys switch between the pane's tabs.

<img src=".github/assets/pane-tour.gif" width="900" alt="An animation: a prompt hands task 7 to the executor, /omca plan opens the board beside the session with task 7 expanded, Down moves to task 8 and Enter opens it as a page, 1 switches to the Agents tab with the executor's lane, 3 to the Evidence tab, and 2 returns to task 8 on the Plan tab.">

The guard dialog arrives the moment the model asks for a destructive command.

<img src=".github/assets/guard-dialog.gif" width="680" alt="An animation: the prompt Clean the build is typed and sent, the model asks to run rm -rf build, and the OMCA guard dialog appears holding the command, listing the build directory it would remove, with Refuse selected.">

## Documentation

- [Usage](docs/usage.md): setup, planning, the band and pane, the guard, the doctor, ratings,
  the status line and troubleshooting.
- [Reference](docs/references.md): agents, skills, MCP tools, hooks and kill switches,
  configuration, state files, where each feature works, and the comparison with similar
  plugins.
- [Contributing](CONTRIBUTING.md): development setup, adding agents, skills and hooks, and the
  prose and comment policy.
- [Changelog](CHANGELOG.md).

## Acknowledgments

Based on [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by
[@code-yeongyu](https://github.com/code-yeongyu).

## License

MIT
