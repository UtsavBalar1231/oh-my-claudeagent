# Known Issues

Live limitations and traps you can hit in normal use, one entry per issue. Resolved
issues are removed from this page rather than kept as history. Check `CHANGELOG.md`
if you want the fix record.

## The statusline emits ANSI color escapes unconditionally

**Symptom**: with a screen reader, the statusline reads as a stream of escape sequences mixed
into the text.

**Why**: `statusline/render.ts` writes color codes with no capability or preference check.
There is no setting that turns them off.

**Workaround**: set `CLAUDE_STATUSLINE_NERD_FONT=0`. That replaces every glyph with a
plain-text equivalent, which removes the font dependency and makes the line readable, but it
does not strip the color escapes.

**Detection**: `CLAUDE_AX_SCREEN_READER` is an environment variable, so the statusline runs as
a subprocess that inherits it and can read it directly. The other two spellings of the same
preference cannot be seen from here: the `--ax-screen-reader` flag and the `axScreenReader`
setting both live inside the client and are never handed to the statusline command. So a
future branch on the env var is workable; a branch on the flag or the setting is not.

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

## The Bash guard does not look inside nested commands

**Symptom**: you expect the `bash-guard` check to stop a recursive removal or a destructive
git command, and a command that plainly does it runs anyway.

**Why**: `classify` in `src/core/destructive.ts` reads the command text for `rm` and `git` at
a command position. It reads through a path (`/bin/rm`), `\rm`, and the `command`, `env`,
`sudo`, `nohup`, `nice`, `exec` and `time` prefixes and `VAR=value` assignments, so those deny
like a bare `rm -rf`. It does not look inside a command that reaches another program as text
or as arguments. Measured against `classify` on the current checkout, all of these return no
finding and fall through to the platform decision:

- a nested shell, `bash -c 'rm -rf DIR'` or `sh -c "rm -rf DIR"`, and likewise
  `bash -c 'git reset --hard'`
- `eval 'rm -rf DIR'`
- a script fed through a heredoc, `bash <<'EOF'` with `rm -rf DIR` in the body, quoted
  delimiter or not
- `timeout 5 rm -rf DIR` and `timeout 5 git reset --hard`
- an argument-fed pipeline, `find DIR -print0 | xargs -0 rm -rf`, or `xargs git reset --hard`
- another tool doing the deletion: `find DIR -delete`, or a one-line Python `rmtree`

Handling of nested shells, `eval`, heredocs and `timeout` is being changed. The remaining
items stay open: widening the pattern to cover them means either a real shell tokenizer or a
prefix list that a caller can always step outside of.

The platform covers part of the nested-shell gap. Since v2.1.288 its critical-path check on
`rm` and `rmdir` reads `sh -c` and `bash -c` scripts, so a nested removal of the root, home or
the working directory is no longer run unprompted in `bypassPermissions` mode or under a shell
allow rule. That check does not cover git, `eval`, heredocs, or removals outside critical
paths.

Flag order, flag case and the long form do not matter: `rm -Rf DIR`, `rm -f -r DIR` and
`rm --recursive DIR` deny like `rm -rf DIR`. A leading git global option does not hide the
subcommand either, so `git -C DIR reset --hard`, `git --git-dir=DIR/.git reset --hard` and
`git -c k=v reset --hard` deny, as do `git checkout REV -- PATH` and `git rm`.

The removal guard is also scoped by target. It denies outright only a target whose loss is
machine-wide: the filesystem root, home, the working directory or a parent of it, a
directory directly under root or home, a `$VAR/` path that lands there when the variable is
empty, a substituted target, or `--no-preserve-root`. A deeper path such as
`rm -rf /tmp/build` or `rm -rf ~/.cache/foo` goes to a confirmation dialog, and where no
dialog can show (`claude -p`) it runs. The guard reads the literal text, so a symlink at a
deep path that points somewhere shallow is not seen.

**Workaround**: treat the guard as a check against a model reaching for the obvious
destructive spelling, not as a security boundary. Anything adversarial, and anything where
the cost of a wrong deletion is real, needs the platform's own layers: `permissions.deny`
and `permissions.ask` rules, sandboxing, or simply not granting the session write access to
the directory in question. Auto mode's classifier reviews most commands but not critical-path
removals, which the platform handles with its own prompt or denial. The OMCA guard sits in
front of those and never replaces them.

## The `omca` MCP server can vanish mid-plan

**Symptom**: `evidence_log` or `boulder_write` fails with a not-connected error partway
through a plan run.

**Why**: the server is plugin-provided, so the tools fail while it is unavailable, such as
during a reconnect window or after a plugin reload.

**Workaround**: re-issue the tool call. Do not skip the evidence step because the call failed
once; the server's failure-recovery handler says the same thing when it sees that error.

## A plan binding can outlive its session

**Symptom**: a new session inherits a stale session title or resolves a plan you thought was
finished with.

**Why**: the server unbinds the session ids it bound in its shutdown handler, which gives up
after 50 ms when another writer holds the registry lock, and a `SIGKILL` skips it entirely.
The 7-day `boulder_write` backstop is then the only pruning until the next server start.

**Workaround**: none needed in practice. The server prunes, at start, bindings pointing at
nothing and plans that are unbound and finished, and every `boulder_write` prunes bindings
older than 7 days.

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

## A restricted session runs with none of the plugin

**Symptom**: in a session started with `--restricted` or with `CLAUDE_CODE_RESTRICTED=1`, no
OMCA hook fires, the `omca` MCP tools are missing, and nothing gates a completion claim.

**Why**: restricted mode loads only managed settings and `--settings`. User, project, and
local settings are ignored, so the plugin's hooks and its MCP server are never registered.
The same mode also removes the built-in tools that run commands or code unless they are named
individually in `--tools`, which takes away the surface the evidence workflow verifies
against. Every guarantee this plugin makes is void in such a session.

**Workaround**: run without the flag when you need the plugin. `CLAUDE_CODE_RESTRICTED` is an
environment variable, so `/oh-my-claudeagent:omca-setup --doctor` reports it when it is
visible in the shell environment; the `--restricted` flag is not visible that way, so a
session that looks unconfigured for no other reason is worth checking against how it was
launched.

**Detection**: the variable is ignored inside a settings file's `env` block, so it can only
have been set in the environment or implied by the flag.
