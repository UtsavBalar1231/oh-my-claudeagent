# Configuration Reference

Every user-facing knob for oh-my-claudeagent in one place: plugin settings, environment
variables, recommended `settings.json` blocks, statusline modes, and the project-rules
injection mechanism.

## Where to look

| You want to... | Go to |
|---|---|
| Toggle keyword triggers, statusline mode, or the forced output style | [Plugin settings](#plugin-settings) |
| Disable a specific hook, or all hooks at once | [`OMCA_DISABLED_HOOKS`](#omca_disabled_hooks-the-unified-kill-switch) |
| Disable one of the older per-hook flags | [Legacy per-hook flags](#legacy-per-hook-flags-deprecated) |
| Reduce permission prompts or restrict `/handoff` | [Recommended settings.json blocks](#recommended-settingsjson-blocks) |
| Configure git worktree isolation for spawned agents | [Worktree settings](#worktree-settings) |
| Pick between daemon and direct statusline rendering | [Statusline modes](#statusline-modes) |
| Write a project rule that auto-injects when a file is touched | [Project rules (`.omca/rules/`)](#project-rules-omcarules) |
| See two ready-made starting configs | [`docs/examples/`](../examples/) |

## Plugin settings

Set under `pluginConfigs["oh-my-claudeagent@omca"].options` in `settings.json`, or via the
plugin's own installer prompts during `/oh-my-claudeagent:omca-setup`.

| Key | Type | Default | What it does |
|---|---|---|---|
| `enableKeywordTriggers` | boolean | `false` | Legacy compatibility setting. When enabled, plain-English phrases in your prompts (e.g. "fix build") can activate OMCA workflows without a slash command. Off by default because keyword matching is imprecise; slash commands are the preferred entrypoint. |
| `statuslineMode` | string: `off`, `direct`, `daemon` | `direct` | Which statusline renderer to use. See [Statusline modes](#statusline-modes). |
| `disableForceOrchestrationStyle` | boolean | `false` | When `true`, strips `force-for-plugin: true` from the installed `output-styles/omca-default.md` cache copy, so your own `outputStyle` setting takes precedence over the plugin's orchestration style. The strip happens at `/oh-my-claudeagent:omca-setup` time and must be re-applied after every plugin update, since the cache copy can be overwritten. |

Example:

```json
{
  "pluginConfigs": {
    "oh-my-claudeagent@omca": {
      "options": {
        "enableKeywordTriggers": false,
        "statuslineMode": "direct"
      }
    }
  }
}
```

## Environment variables

### `OMCA_DISABLED_HOOKS`: the unified kill switch

The primary escape hatch for turning off individual OMCA hooks without editing
`hooks/hooks.json`. Set it to a comma- and/or whitespace-separated list of hook
basenames (no `.sh` suffix). Any hook whose basename appears in the list becomes a
no-op for the rest of the session.

```bash
# Turn off the plan-continuation guard for this session
OMCA_DISABLED_HOOKS=plan-continuation-guard

# Turn off more than one hook
OMCA_DISABLED_HOOKS="plan-continuation-guard,drift-guard"
```

This is the recommended way to silence the plan-continuation guard if it is nudging you
to keep working on a plan you have intentionally paused, or to mute any other hook that
is getting in the way during a specific session.

Hooks that currently honor `OMCA_DISABLED_HOOKS`:

| Hook basename | What it normally does |
|---|---|
| `final-verification-evidence` | Blocks session Stop when the bound plan is fully checked off but no `final_verification` evidence entry has been logged for it. |
| `plan-continuation-guard` | Blocks session Stop when the bound plan still has unchecked numbered tasks, nudging the agent to keep going instead of stopping mid-plan. |
| `tool-loop-detector` | Warns when the same tool call repeats several times in a row, a common sign of a blind retry loop. |
| `write-guard` | Warns before a `Write` call overwrites an existing file, and intercepts direct writes to evidence state. |
| `plan-format-warn` | Warns when a plan file's checkboxes don't follow the numbered `- [ ] N.` form that progress tracking depends on. |
| `delegation-reminder` | One-time nudge to delegate to a specialist agent instead of doing repeated direct work in the main session. |
| `comment-checker` | Flags narrating, step-by-step, or plan-internal comments in code you write or edit. |

Set the variable in your shell profile, in a wrapper script, or per-invocation, depending
on whether the override should be permanent or one-off.

### Legacy per-hook flags (deprecated)

These predate `OMCA_DISABLED_HOOKS` and still work, but new configurations should prefer
the unified switch above. Each one only covers a single hook, and the two mechanisms use
OR semantics: a hook is disabled if *either* its legacy flag is set to `1` *or* its
basename is present in `OMCA_DISABLED_HOOKS`.

| Variable | Value | Disables |
|---|---|---|
| `OMCA_HOOK_DISABLE_FINAL_VERIFY` | `1` | `final-verification-evidence`: same effect as adding `final-verification-evidence` to `OMCA_DISABLED_HOOKS`. |
| `OMCA_HOOK_DISABLE_DRIFT_GUARD` | `1` | `drift-guard`: the check that blocks a completion claim while stub markers remain on newly added lines. |
| `OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY` | `1` | `git-destructive-deny`: the guard that blocks `git reset --hard`, `git stash`, `git checkout --`, `git clean`, and `git restore` from being run through the agent. |

### Other environment variables

| Variable | Purpose |
|---|---|
| `OMCA_PROBE_OUTPUT` | Output file path for the one-shot `UserPromptSubmit` payload capture script used during hook development. Not part of normal operation, and not registered as a permanent hook; only relevant if you are debugging the hook payload shape yourself. |

## Recommended settings.json blocks

These are opt-in blocks you add to your own `settings.json` (user or project scope, as
noted). None of them are applied automatically by the plugin.

### Restrict `/handoff` to manual invocation

Handoff is meant to be a deliberate user action, not something the model triggers on its
own mid-conversation (for example, when it judges that context has gotten long). Add this
to prevent self-invocation:

```json
{
  "skillOverrides": {
    "oh-my-claudeagent:handoff": "user-invocable-only"
  }
}
```

### Worktree settings

These control how `isolation: worktree` agents and `/start-work --worktree` set up their
isolated git worktrees.

| Setting | Purpose |
|---|---|
| `worktree.symlinkDirectories` | Array of directory names (relative to the repo root) to symlink into each new worktree instead of copying them. Use this for `node_modules` or a large build cache that would otherwise be duplicated per worktree. |
| `worktree.sparsePaths` | Array of paths to check out via git sparse-checkout (cone mode) in each worktree. Only listed paths are written to disk, which speeds up worktree creation in large monorepos. Omit to check out the full tree. |
| `worktree.baseRef` | Controls which ref a new worktree branches from: `"fresh"` (default) branches from `origin/<default-branch>`; `"head"` branches from local `HEAD`. See [`docs/reference/known-issues.md`](known-issues.md) for the unpushed-commits trap this setting controls. |

```json
{
  "worktree": {
    "symlinkDirectories": ["node_modules", ".cache"],
    "sparsePaths": ["packages/my-app", "shared/utils"],
    "baseRef": "head"
  }
}
```

## Statusline modes

Set via the `statuslineMode` plugin setting (`off`, `direct`, `daemon`) or, for finer
per-session control, the `CLAUDE_STATUSLINE_MODE` environment variable read directly by
the statusline client.

| Mode | Behavior |
|---|---|
| `off` | No OMCA statusline is installed; your own `statusLine` configuration (if any) is left untouched. |
| `direct` | Renders the statusline inline on every invocation, no background process. Simpler, no daemon to manage, slightly higher per-call latency. This is the default. |
| `daemon` | A background daemon process pre-computes statusline state so each render is fast; falls back to direct rendering automatically if the daemon is not running. Recommended when you want the statusline to refresh frequently without adding per-call overhead. |

`CLAUDE_STATUSLINE_MODE=daemon` is the client's own default when set, and it falls back to
direct rendering if the daemon is unavailable; `CLAUDE_STATUSLINE_MODE=direct` always
skips the daemon and renders inline.

`/oh-my-claudeagent:omca-setup` writes the platform-level `statusLine` and
`subagentStatusLine` blocks for you (including `hideVimModeIndicator` and a
`refreshInterval` so the statusline keeps polling during idle background-agent runs);
re-run it if those fields are ever missing.

## Project rules (`.omca/rules/`)

Drop a Markdown file into `.omca/rules/` in your project to have its contents
automatically surfaced whenever you read, write, or edit a matching file.

Each rule file's first line declares which files it applies to:

```markdown
# pattern: *.tsx
Prefer function components. Co-locate styles with the component file.
```

- The first line must be exactly `# pattern: <glob>`, matched against the filename
  (not the full path) of the file being read, written, or edited.
- Everything after the first line is the rule body that gets injected as additional
  context, capped at roughly 1000 characters. If the body is longer, the injected
  context is truncated and a pointer back to the full rule file is included.
- A rule is injected once per session per matching directory context; editing the rule
  file's content causes it to be re-injected the next time a matching file is touched,
  since the dedup key is content-hash based.
- Multiple rule files can exist side by side, each with its own pattern; a file is
  checked against every rule in `.omca/rules/`.

## See also

- [`docs/examples/`](../examples/): two ready-made `settings.json` presets (low-friction
  and strict) built from the blocks documented above.
- [`docs/reference/known-issues.md`](known-issues.md): verified limitations and
  workarounds, including the worktree `baseRef` unpushed-commits trap referenced above.
