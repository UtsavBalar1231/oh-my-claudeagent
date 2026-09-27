## PHASE 1: GATHER CONTEXT

Run in parallel:

```bash
git diff --stat HEAD~10..HEAD 2>/dev/null || git log --oneline -10
git status --porcelain
git branch --show-current
git log --oneline -5
```

Also: `omca_boulder_progress()`, `omca_notepad_read` for active plan sections, and the plan files under `.opencode/plans/` and `.omca/plans/`. Treat the plan file's numbered checkboxes and `omca_boulder_progress()` as the primary source.

## PHASE 4: INSTRUCT

```
TO CONTINUE IN A NEW SESSION:

1. Start a new OpenCode session with /new
2. Paste the HANDOFF CONTEXT above as your first message
3. Add: "Continue from the handoff context above. [Your next task]"
```

## Invocation

Handoff is a user-driven workflow, so this skill is not advertised to the model: it runs
when you type `/omca-handoff`, and it is not preloaded into subagents.
