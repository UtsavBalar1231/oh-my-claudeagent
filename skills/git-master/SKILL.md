---
name: git-master
description: "MUST USE for ANY git operations. Atomic commits, rebase/squash, history search (blame, bisect, log -S). Triggers: 'commit', 'rebase', 'squash', 'who wrote', 'when was X added', 'find the commit that'."
model: opus
argument-hint: "[commit | rebase | blame | bisect]"
effort: medium
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git status *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git blame *)
  - Bash(git show *)
  - Bash(git branch --show-current)
  - Bash(git branch -vv)
  - Bash(git merge-base *)
  - Bash(git rev-parse *)
  - mcp__plugin_oh-my-claudeagent_omca__ast_search
  - mcp__plugin_oh-my-claudeagent_omca__evidence_log
---

# Git master

Use `Bash` for git operations. Match the requested operation: inspection and history search are read-only, not permission to stage, commit, rewrite, or push. Do not edit files or delegate as part of this skill. Do not commit or push unless explicitly requested.

## Inspect and commit

Read status, staged and unstaged diffs, the current branch, and upstream state before mutations. Preserve unrelated work. For commits, inspect recent messages and follow the repository's style. Group each independently reviewable concern with its tests; explain why inseparable files belong together. Stage explicit paths and inspect the staged diff before committing. Verify the resulting commit and remaining working-tree state.

## Rewrite safely

Before a rebase, amend, or reset, confirm the branch, account for dirty work with the user, check whether commits were pushed, and name a recovery path. Use `git rebase --abort`, `git reset --keep ORIG_HEAD`, or the reflog as appropriate. Never rewrite main/master. Rewrite pushed history only with explicit approval; an approved rewritten push uses --force-with-lease, never --force.

Stashing or discarding work is the user's step. Do not run reset --hard, checkout --, restore, clean, or stash to discard or hide changes from this shell. Stop at conflicts and report the files and next commands unless conflict resolution was requested. Do not guess resolutions.

## Non-interactive commands

The shell cannot answer an editor or credential prompt. For commands that open an editor, use `git -c core.editor=true`; do not start an interactive editor. Keep read-only commands plain so permission rules still match. Report authentication or command failures instead of retrying blindly or claiming success.

## History and evidence

Use `git log -S` for an added or removed string, `git log -G` for changed matching lines, `git blame` for ownership, and `git log --follow -- <path>` for file history. Run bisect only when requested and account for its checkout changes first.

Attach requested PR evidence through the PR upload flow. Do not commit temporary evidence images or repurpose release artifacts. Log any build, test, or lint runs with `evidence_log` and their real exit codes.
