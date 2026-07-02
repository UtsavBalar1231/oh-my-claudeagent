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
  "skillOverrides": {
    "oh-my-claudeagent:handoff": "user-invocable-only"
  },
  "worktree": {
    "baseRef": "head"
  }
}
```

- `permissions.allow` only covers read-only inspection commands; anything that changes
  repo state (`git push`, `git commit`) stays in `ask` so a human confirms it explicitly.
- `enableKeywordTriggers: false` keeps every workflow entrypoint on explicit slash
  commands, eliminating false-positive activation from conversational phrasing.
- `statuslineMode: "daemon"` keeps the statusline responsive without adding per-call
  overhead to every tool invocation, useful when watching a long session closely.
- `skillOverrides` forces `/handoff` to be a deliberate user action rather than
  something the model can trigger on its own mid-session.
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
