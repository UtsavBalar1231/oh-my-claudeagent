---
name: handoff
description: Create a detailed context summary for continuing work in a new session. Use when context is getting long, session quality is degrading, or the context window is approaching capacity.
user-invocable: true
shell: bash
argument-hint: optional notes about what to include
---

# Handoff - Session Context Summarization

## Tool Restrictions

Read-only. No Write/Edit/Agent. MCP tools: `mode_read`, `boulder_progress`, `notepad_read`, `notepad_list`.

Self-contained handoff summary for seamless new-session continuation.

## PHASE 0: VALIDATE

Confirm meaningful work exists. Nearly empty session → inform user nothing to hand off.

## PHASE 1: GATHER CONTEXT

Run in parallel:

```bash
git diff --stat HEAD~10..HEAD 2>/dev/null || git log --oneline -10
git status --porcelain
git branch --show-current
git log --oneline -5
```

Also: `TaskList()`, `mode_read(mode="boulder")`, `notepad_read` for active plan sections, `Glob(".claude/plans/*.md")`.

## PHASE 2: EXTRACT

First person ("I did...", "I told you..."):
- What was done, what remains
- KEY FILES (max 10, workspace-relative)
- USER REQUESTS verbatim — no paraphrasing
- EXPLICIT CONSTRAINTS verbatim — no inventing

## PHASE 3: FORMAT OUTPUT

```
HANDOFF CONTEXT
===============

USER REQUESTS (AS-IS)
---------------------
- [Exact verbatim user requests]

GOAL
----
[One sentence: what should be done next]

PROGRESS
--------
Tasks completed: X / Y total
- [x] [Completed task name]
- [ ] [Pending task name]
(Use TaskList() counts and checkboxes — do not invent)

NOTEPAD SUMMARY
---------------
[Only include if an active plan with notepad data exists]
Plan: [plan-name]
- learnings: N entries — [one-line summary of key insight]
- issues: N entries — [one-line summary of open issue if any]
- decisions: N entries — [list verbatim from notepad decisions section, one per line]
- problems: N entries — [summary if non-zero]
- questions: N entries — [list open questions if non-zero]

WORK COMPLETED
--------------
- [First person bullets of what was done]
- [Include specific file paths]

CURRENT STATE
-------------
- [Current state of codebase or task]
- [Build/test status if applicable]

REMAINING WORK
--------------
- [ ] [Unchecked plan task — copy exact task text]
- [ ] [Next logical step if not in plan]
(Pull from plan file checkboxes and TaskList() state)

KEY FILES
---------
- [path/to/file] - [brief role]
(Maximum 10 files, prioritized by importance)

IMPORTANT DECISIONS
-------------------
- [Technical decisions and why — pull from notepad decisions section if available]
- [Trade-offs considered]

EXPLICIT CONSTRAINTS
--------------------
- [Verbatim constraints only — from user or existing AGENTS.md]
- If none: None

CONTEXT FOR CONTINUATION
------------------------
- [What the next session needs to know]
- [Warnings or gotchas]
```

Rules:
- Plain text, no markdown headers in output
- No bold/italic/code fences in content fields
- Only what matters for continuation
- USER REQUESTS and CONSTRAINTS: verbatim only
- PROGRESS: actual TaskList() counts
- NOTEPAD SUMMARY: omit if no active plan/notepad data
- REMAINING WORK: verbatim from plan file

## PHASE 4: INSTRUCT

```
TO CONTINUE IN A NEW SESSION:

1. Start a new Claude Code session: claude
2. Paste the HANDOFF CONTEXT above as your first message
3. Add: "Continue from the handoff context above. [Your next task]"
```

## Constraints

- No programmatic session creation
- No sensitive information (API keys, credentials)
- Max 10 KEY FILES
- User requests quoted verbatim
