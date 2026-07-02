# Known Issues

Live limitations and traps you can hit in normal use, one entry per issue. Resolved
issues are removed from this page rather than kept as history. Check `CHANGELOG.md`
if you want the fix record.

## `worktree.baseRef` hides unpushed commits by default

**Symptom**: you delegate to an agent with `isolation: worktree` (or run
`/oh-my-claudeagent:start-work --worktree`), and the agent's view of the repo is
missing commits you made locally but never pushed. It sees the last pushed state of
your default branch, not your working branch.

**Why**: new worktrees branch from `origin/<default-branch>` (`baseRef: "fresh"`) by
default. This is deliberate (it gives a clean tree for isolated work), but it means
local-only commits are invisible inside the worktree.

**Workaround**: set in your user `~/.claude/settings.json` (or project settings):

```json
"worktree": { "baseRef": "head" }
```

`"head"` branches new worktrees from your current local HEAD instead, so unpushed
commits and feature-branch state carry over. Confirmed correct in this project's tested
Claude Code build (see Tracking): a worktree created under `baseRef: "head"` contained
the unpushed commit; the same setup under the default `"fresh"` did not.

Agents that run in your main checkout instead of a worktree (OMCA's `explore` and
`librarian`) are unaffected: they always see uncommitted and unpushed work.

**Tracking**: verified empirically against Claude Code v2.1.198 (2026-07-02): a scratch
git repo with a bare remote and one unpushed local commit, driven headlessly via
`claude -p ... -w <name>`, showed the trap under the default setting and confirmed the
fix under `baseRef: "head"`. Re-test if you're on a materially older or newer Claude
Code build. See also `CLAUDE.md` in this repo for the setting's history.
