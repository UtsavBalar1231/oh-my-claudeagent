---
name: handoff
description: Write a self-contained context summary that a new session can continue from.
when_to_use: |
  Use when:
  - Context window is getting long or session quality is degrading
  - Approaching context window capacity
  - User says "handoff", "context is long", or "start fresh"
  - Switching to a new Claude Code session mid-task
user-invocable: true
disable-model-invocation: true
shell: bash
argument-hint: optional notes about what to include
allowed-tools:
  - Read
  - Glob
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git branch --show-current)
  - TaskList
  - TaskGet
  - mcp__plugin_oh-my-claudeagent_omca__notepad_read
  - mcp__plugin_oh-my-claudeagent_omca__notepad_list
---

# Handoff

Run this on a direct request for a handoff. A long conversation alone is not authorization. Read-only: do not change files or task state, delegate, or create a session.

Write compact, self-contained continuation context: the goal and exact constraints, verified progress, relevant changed files, decisions, blockers, and the next action. Quote requests and explicit constraints accurately; do not invent requirements. Inspect only the status, diff, plan, or notepad details needed to make those statements accurate. Report only the plan this session is working on; do not select another session's plan. Read relevant notepad sections with `notepad_read` when needed.

Separate observed results from assumptions and pending checks. Do not invent task counts, dump metadata or transcripts, include credentials, or imply historical evidence verifies the current checkout. Copy remaining plan tasks accurately. If there is no meaningful work to transfer, say so. Let the user choose whether to start a new session and paste the context there.

## Claude Code

This skill is user-invoked through `/oh-my-claudeagent:handoff`; do not load it automatically. Find a requested plan document in the configured `plansDirectory`, `~/.claude/plans` by default, or `.omca/plans`.

A run's tasks live on Claude Code's task list, which a new session in this checkout shares. Load the task tools with `ToolSearch({query: "select:TaskCreate,TaskUpdate,TaskList,TaskGet", max_results: 4})` and read the list with `TaskList`. The task tools do not return metadata, so call `TaskGet` on an open `Final verification` task: its description names the run and its plan document, and its `Blocked by:` line lists the run's tasks. The run's notepad `issues` section names the tasks closed as blocked, which the list prints with their last status. Name the run and its open tasks by id and subject; there is no need to restate their descriptions, since the next session reads them from the list.

The user can start a new session with `claude`, paste the handoff as the first message, and run `/oh-my-claudeagent:start-work` to continue the run. Do not create the session programmatically.
