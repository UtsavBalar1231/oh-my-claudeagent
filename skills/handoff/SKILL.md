---
name: handoff
description: Create a detailed context summary for continuing work in a new session. Use when context is getting long, session quality is degrading, or the context window is approaching capacity.
user-invocable: true
shell: bash
argument-hint: optional notes about what to include
---

# Handoff - Session Context Summarization

## Tool Restrictions

This is a read-only skill. DO NOT use these tools:
- **Write** / **Edit** — Do not create or modify files
- **Agent** — Do not delegate; gather context directly

MCP tools available for reading state: `mode_read`, `boulder_progress`, `notepad_read`, `notepad_list`.

Creates a self-contained handoff summary so work can continue seamlessly in a new session.

## Slash entrypoint

- `/oh-my-claudeagent:handoff`

## PHASE 0: VALIDATE

Confirm there is meaningful work in this session to preserve. If the session is nearly empty,
inform the user there is nothing to hand off.

## PHASE 1: GATHER CONTEXT

Run in parallel:

```bash
git diff --stat HEAD~10..HEAD 2>/dev/null || git log --oneline -10
git status --porcelain
git branch --show-current
git log --oneline -5
```

Also gather:
- `TaskList()` — current task progress and pending items
- `Read(".omca/state/boulder.json")` — active plan state if it exists
- If an active plan exists (from boulder state), read notepad data:
  - `Read(".omca/state/notepads/{plan-name}/")` — per-plan notepad sections (learnings, issues, decisions, problems)
- `Glob(".claude/plans/*.md")` — recent native plan files

## PHASE 2: EXTRACT

Write the summary from first person ("I did...", "I told you..."). Focus on:
- What was done and what remains
- KEY FILES (max 10, workspace-relative paths)
- USER REQUESTS must be verbatim — do not paraphrase
- EXPLICIT CONSTRAINTS must be verbatim — do not invent

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
- Plain text, no markdown `#` headers in the output
- No bold/italic/code fences within content fields
- Only include what matters for continuation
- USER REQUESTS and EXPLICIT CONSTRAINTS: verbatim only
- PROGRESS: use actual TaskList() counts, not estimates
- NOTEPAD SUMMARY: omit section if no active plan or no notepad data
- REMAINING WORK: copy task text verbatim from the plan file — do not paraphrase

## PHASE 4: INSTRUCT

```
TO CONTINUE IN A NEW SESSION:

1. Start a new Claude Code session: claude
2. Paste the HANDOFF CONTEXT above as your first message
3. Add: "Continue from the handoff context above. [Your next task]"
```

## Constraints

- DO NOT attempt to programmatically create new sessions
- DO NOT include sensitive information (API keys, credentials)
- DO NOT exceed 10 files in KEY FILES
- DO NOT paraphrase user requests — quote verbatim
