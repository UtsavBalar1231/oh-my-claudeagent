# Preset: low friction

Optimized for fast iteration in a trusted local repo: fewer permission prompts, hooks
kept to advisory (non-blocking) behavior, and keyword triggers on so plain-English
requests can activate OMCA workflows without typing a slash command.

Use this when you are working solo, the repo has no destructive-action risk you're
worried about, and you would rather move fast and re-run a check manually than be
stopped by a gate.

```json
{
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(npm run *)",
      "Bash(just *)",
      "Bash(uv run *)"
    ]
  },
  "pluginConfigs": {
    "oh-my-claudeagent@omca": {
      "options": {
        "enableKeywordTriggers": true,
        "statuslineMode": "direct"
      }
    }
  }
}
```

- `permissions.allow` pre-approves read-only and common build/test commands, so you
  aren't interrupted for the same handful of commands every session.
- `enableKeywordTriggers: true` lets phrases like "fix build" activate OMCA workflows
  without requiring the matching slash command: convenient for fast, conversational
  iteration, at the cost of occasional false-positive activation.
- `statuslineMode: "direct"` avoids managing a background daemon process, trading a
  small amount of per-render latency for simplicity.

```bash
# Loosen the evidence gates for this session. Useful when you're prototyping and
# don't want the Stop hooks blocking on missing final_verification evidence yet.
OMCA_DISABLED_HOOKS="final-verification-evidence,plan-continuation-guard"
```

- Disabling `final-verification-evidence` and `plan-continuation-guard` removes the
  two Stop-time gates that otherwise require a completed plan to have logged evidence
  and finished all its tasks before the session can end. Appropriate for exploratory
  work where you plan to circle back and verify later, not for work you intend to ship
  without further review.

For destructive-git protection, leave `git-destructive-deny` and `drift-guard` enabled
even in a low-friction setup: they guard against actions that are expensive to
undo (lost work, false completion claims), not against ordinary friction.
