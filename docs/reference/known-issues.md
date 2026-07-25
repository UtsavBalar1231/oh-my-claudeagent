# Known Issues

Live limitations and traps you can hit in normal use, one entry per issue. Resolved
issues are removed from this page rather than kept as history. Check `CHANGELOG.md`
if you want the fix record.

## The repeated-tool-call nudge shares one slot across concurrent agents

**Symptom**: you fan out several subagents, one of them genuinely loops on the same Grep
three times, and no nudge appears. Or the opposite: three unrelated agents happen to issue
the same call and one of them is told it is looping when it is not.

**Why**: `tool-loop-detector.sh` keeps a single global window at
`.omca/state/tool-loop-window.json` holding one signature and one count. The main session and
every concurrent subagent write to that same slot, so interleaved calls from different agents
overwrite each other's signature and reset a real streak (the common case, a false negative),
and coincidentally identical calls from different agents accumulate into one count (the rarer
false positive).

**Workaround**: none needed for correctness, since the nudge is advisory and the detector
never blocks. Treat its absence during parallel fan-out as expected rather than as evidence
that no loop happened.

**Tracking**: the `prompt_id` stamp added to the window fixes only the user-turn-boundary
case, not this one. The correct scoping key is `agent_id`, which means either one state file
per agent or a keyed map with garbage collection on `SubagentStop`. That is a design decision
rather than a patch, so it is deliberately open. Schema detail in
`.claude/rules/state-schemas.md`.

## The statusline emits ANSI color escapes unconditionally

**Symptom**: with a screen reader, the statusline reads as a stream of escape sequences mixed
into the text.

**Why**: `statusline/core.py` writes color codes with no capability or preference check.
There is no setting that turns them off.

**Workaround**: set `CLAUDE_STATUSLINE_NERD_FONT=0`. That replaces every glyph with a
plain-text equivalent, which removes the font dependency and makes the line readable, but it
does not strip the color escapes. A `CLAUDE_AX_SCREEN_READER` branch is deliberately not
documented as working here: neither its settings nor its flag form is confirmed to reach the
statusline environment, so recommending it would be a guess.

**Tracking**: the glyph half is solved; making the escapes conditional is open.

## Under `dontAsk` permission mode, setup fails with no dialog

**Symptom**: `/oh-my-claudeagent:omca-setup` reports partial success or silently skips its
settings writes, and no permission prompt ever appeared.

**Why**: `dontAsk` auto-denies anything that would have prompted, rather than prompting. The
skill's writes to `~/.claude/settings.json` land in that category.

**Workaround**: run setup in a mode that can prompt, then switch back.

## `.claude/**` writes are never auto-approved

**Symptom**: you add `Edit(.claude/**)` to `permissions.allow` and the write is still
blocked.

**Why**: protected paths are checked before allow rules are consulted at all, so no allow
rule can grant a write under `.claude/`. This is platform policy, not an OMCA hook.

**Workaround**: none. Write those files yourself, or approve each write interactively.

## The Bash deny guards catch direct invocations only

**Symptom**: you expect `permission-filter.sh` to stop a recursive removal, and a command
that plainly deletes a tree runs anyway. Same for `git-destructive-deny.sh` and a
destructive git subcommand.

**Why**: both guards match a literal command name at a command position. Anything that
reaches the same operation through another name, another binary, or another process
sidesteps the pattern. Measured against the current scripts on a `PreToolUse` payload, all
of these fall through to the platform decision rather than denying:

- an absolute or relative path, `/bin/rm -rf DIR`, and likewise `/usr/bin/git reset --hard`
- a builtin bypass, `command rm -rf DIR`
- a quoting bypass, `\rm -rf DIR`
- a wrapper that takes the real command as arguments: `env rm -rf DIR`, `nohup rm -rf DIR`,
  `timeout 5 rm -rf DIR`, `sudo -u someone rm -rf DIR`
- a variable assignment prefix, `FOO=1 rm -rf DIR`
- an argument-fed pipeline, `find DIR -print0 | xargs -0 rm -rf`
- a nested shell, `bash -c 'rm -rf DIR'`
- long-form flags, `rm --recursive --force DIR`
- another tool doing the deletion: `find DIR -delete`, or a one-line Python `rmtree`

Widening the pattern to cover these means either a real shell tokenizer inside a bash hook
or a prefix list that a caller can always step outside of. Neither turns the guard into
something it is not.

**Workaround**: treat these hooks as a guardrail against a model reaching for the obvious
destructive spelling, not as a security boundary. Anything adversarial, and anything where
the cost of a wrong deletion is real, needs the platform's own layers: `permissions.deny`
and `permissions.ask` rules, auto mode's classifier, sandboxing, or simply not granting the
session write access to the directory in question. The OMCA hooks sit in front of those and
never replace them.

## Version floors worth knowing

Each of these was a real failure mode below the version named. If you are on an older client,
expect the behavior described.

| Floor | Below it |
|---|---|
| v2.1.200 | Project-scoped plugins did not load from worktrees. A `--plugin-dir` install meant a worktree-isolated run executed with no OMCA hooks and no MCP server. This checkout is project-scoped |
| v2.1.203 | A worktree-isolated subagent could run Bash in the parent checkout instead of its own worktree |
| v2.1.205 | On Windows, `worktree.symlinkDirectories` could delete files outside the worktree when the worktree was removed. Do not enable it below this version on Windows |
| v2.1.207 | `worktree.sparsePaths` left `extensions.worktreeConfig` behind in the repo config after worktree removal, which breaks go-git-based tooling |
| v2.1.208 | A Grep with an invalid regex or a null byte returned zero results instead of an error, so "not present" and "rejected pattern" looked identical. Many deny or ask rules also cost multiple seconds per call |
| v2.1.210 | Git mutations from inside a worktree could escape it, and accepting a plan could overwrite the plan file with a stale snapshot. That overwrite resurrects checked boxes, which falsifies both checkbox-derived completion and the `plan_sha256` evidence binding, so v2.1.210 is the practical floor for plan-driven work |
| v2.1.211 | A hook returning `ask` could be overridden by the auto-mode classifier's allow under unsandboxed Bash. A subagent model override was also reverted on resume |
| v2.1.212 | A committed `.claude/worktrees` symlink was an escape path, and plan-mode Bash could mutate files unprompted |
| v2.1.216 | `git -C`, `--git-dir`, and `GIT_DIR`/`GIT_WORK_TREE` could redirect a worktree-isolated subagent's git into the shared checkout, and read-only commands on Windows could reach network paths with no permission prompt |

## The `omca` MCP server can vanish mid-plan

**Symptom**: `evidence_log` or `boulder_write` fails with a not-connected error partway
through a plan run.

**Why**: the server is plugin-provided, so it is torn down and restarted on a mid-session
plugin re-sync, and it needs to reconnect after an idle web session wakes. The teardown was
fixed in v2.1.210 and the idle-wake reconnect in v2.1.211, so v2.1.211 is the floor for both.

**Workaround**: re-issue the tool call. Do not skip the evidence step because the call failed
once; `json-error-recovery.sh` says the same thing when it sees that error.

## A killed SessionEnd hook leaves this session's plan binding behind

**Symptom**: a new session inherits a stale session title or resolves a plan you thought was
finished with.

**Why**: the platform's `SessionEnd` budget is 1.5 seconds and can only be raised by a
per-hook `timeout` in a *settings file*. A `timeout` in a plugin's own `hooks.json` never
raises it, so `session-cleanup.sh` can be killed before it deletes this session's binding.

**Workaround**: none needed in practice. The next `SessionStart` runs the boulder garbage
collector, which prunes bindings pointing at nothing and plans that are unbound and finished.
Raising the handler's `timeout` value does not help and is not the fix.

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
