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
  - mcp__plugin_oh-my-claudeagent_omca__boulder_progress
  - mcp__plugin_oh-my-claudeagent_omca__notepad_read
  - mcp__plugin_oh-my-claudeagent_omca__notepad_list
---

# Handoff

Run only when the user explicitly asks for a handoff. A long conversation alone is not authorization. Read-only: do not change files, register or bind a plan, delegate, or create a session.

Write compact, self-contained continuation context: the goal and exact constraints, verified progress, relevant changed files, decisions, blockers, and the next action. Quote requests and explicit constraints accurately; do not invent requirements. Inspect only the status, diff, plan, or notepad details needed to make those statements accurate. Use `boulder_progress` only for this session's explicitly bound plan; do not select another session's plan. Read relevant notepad sections with `notepad_read` when needed.

Separate observed results from assumptions and pending checks. Do not invent task counts, dump metadata or transcripts, include credentials, or imply historical evidence verifies the current checkout. Copy remaining plan tasks accurately. If there is no meaningful work to transfer, say so. Let the user choose whether to start a new session and paste the context there.

## Claude Code

This skill is user-invoked through `/oh-my-claudeagent:handoff`; do not load it automatically. Find a requested plan in the configured `plansDirectory`, or `~/.claude/plans` by default. The user can start a new session with `claude` and paste the handoff as the first message. Do not create the session programmatically.
