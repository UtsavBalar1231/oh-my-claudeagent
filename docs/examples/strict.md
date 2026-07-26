# Preset: strict

Optimized for shared or production-adjacent repos: every evidence gate stays on,
permissions stay conservative, and destructive actions require explicit confirmation
every time.

Use this when multiple people rely on the repo's history and state, when a completion
claim needs to be trustworthy without manual double-checking, or when you want the
agent to stop and ask rather than guess.

```json
{
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Bash(git diff*)",
      "Bash(git log*)"
    ],
    "ask": [
      "Bash(git push*)",
      "Bash(git commit*)"
    ]
  },
  "pluginConfigs": {
    "oh-my-claudeagent@omca": {
      "options": {
        "enableKeywordTriggers": false,
        "statuslineMode": "daemon"
      }
    }
  },
  "worktree": {
    "baseRef": "head"
  }
}
```

**Put this in your user `~/.claude/settings.json`, not in the repo.** As of v2.1.207
`pluginConfigs` is not read from a project's shared `.claude/settings.json`, so committing
this preset to a repo makes the plugin-settings half a silent no-op.

- `permissions.allow` only covers read-only inspection commands; anything that changes
  repo state (`git push`, `git commit`) stays in `ask` so a human confirms it explicitly.
- `enableKeywordTriggers: false` keeps every workflow entrypoint on explicit slash
  commands, eliminating false-positive activation from conversational phrasing.
- `statuslineMode: "daemon"` keeps the statusline responsive without adding per-call
  overhead to every tool invocation, useful when watching a long session closely.
- `/handoff` needs no entry here. It ships with `disable-model-invocation: true`, so the
  model cannot self-invoke it; the `skillOverrides` block this preset used to carry did
  nothing, since that key does not apply to plugin-shipped skills.
- `worktree.baseRef: "head"` ensures spawned worktree agents branch from your local
  `HEAD`, not `origin/<default-branch>`, so unpushed local commits are never silently
  dropped out of an isolated worktree's starting point. See
  [`docs/reference/known-issues.md`](../reference/known-issues.md) for the failure mode
  this setting prevents.

Leave every OMCA hook at its default. Do not set `OMCA_DISABLED_HOOKS` or any of the
legacy `OMCA_HOOK_DISABLE_*` flags. The evidence gates (`final-verification-evidence`,
`plan-continuation-guard`), the destructive-git guard, and the completion-stub guard
(`drift-guard`) are exactly the checks a strict setup wants enforced:

- `final-verification-evidence` guarantees a completed plan has a logged verification
  verdict before the session can end.
- `plan-continuation-guard` guarantees the agent doesn't stop with unchecked plan tasks
  remaining.
- `git-destructive-deny` blocks `git reset --hard`, `git stash`, `git checkout --`,
  `git clean`, and `git restore` from being run through the agent at all.
- `drift-guard` blocks a completion claim while stub markers remain on newly added
  lines in the working tree.

Two adjacent choices a strict setup should make deliberately:

- Add `Agent(model:fable)`, `Agent(isolation:worktree)`, and `Bash(run_in_background:true)` to
  `permissions.deny` or `permissions.ask` if you want delegation tier, worktree isolation, and
  backgrounded shell commands gated per call. Use the alias form for the model: the rule matches
  the literal input Claude sends, and OMCA's delegation guidance passes an alias rather than a
  pinned id, so a pinned id will not match. `fable` is the tier worth gating, since the roster
  declares `opus` in frontmatter and reaches `fable` only through an explicit override. Note the
  limit of the syntax: an agent whose tier comes from its own frontmatter sends no `model`
  parameter, and an omitted parameter is never matched, so this rule gates explicit per-call
  overrides only.
- Do not add `Write(<path>)`, `NotebookEdit(<path>)`, or `Glob(<path>)` rules. They are
  accepted but never match, and the platform prints a startup warning for each. `Edit(<path>)`
  already covers every file-editing tool including `Write`.

If your org sets `allowManagedHooksOnly`, this plugin must be force-enabled in managed
`enabledPlugins` or every hook above, evidence gates included, stops running with no error.
`strictPluginOnlyCustomization` is not part of that hazard: it confines hooks to plugin and
managed sources, which is where OMCA's already come from.
