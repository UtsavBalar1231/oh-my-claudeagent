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
| Change how strictly comments in your code are policed | [`OMCA_COMMENT_GATE`](#omca_comment_gate-the-comment-gates-enforcement-level) |
| Reduce permission prompts, cap model tiers, or scope auto mode | [Recommended settings.json blocks](#recommended-settingsjson-blocks) |
| Make the sandbox network allowlist fail closed | [Sandbox network settings](#sandbox-network-settings) |
| Configure git worktree isolation for spawned agents | [Worktree settings](#worktree-settings) |
| Pick between daemon and direct statusline rendering | [Statusline modes](#statusline-modes) |
| Write a project rule that auto-injects when a file is touched | [Project rules (`.omca/rules/`)](#project-rules-omcarules) |
| See two ready-made starting configs | [`docs/examples/`](../examples/) |

## Plugin settings

Set under `pluginConfigs["oh-my-claudeagent@omca"].options` in `settings.json`, or via the
plugin's own installer prompts during `/oh-my-claudeagent:omca-setup`.

**Scope**: as of v2.1.207 `pluginConfigs` is **not** read from a project's shared
`.claude/settings.json`. Put the block in your user `~/.claude/settings.json` (or pass it via
`--settings`). A `pluginConfigs` block committed to a repo is a silent no-op.

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

# Turn off every OMCA hook at once (`*` is equivalent)
OMCA_DISABLED_HOOKS=all
```

This is the recommended way to silence the plan-continuation guard if it is nudging you
to keep working on a plan you have intentionally paused, or to mute any other hook that
is getting in the way during a specific session.

Two reserved tokens, `all` and `*`, match every hook regardless of the rest of the list, so
`OMCA_DISABLED_HOOKS=all` disables the whole set in one step.

Hooks that honor `OMCA_DISABLED_HOOKS` (grep `hook_is_disabled` in `scripts/` for the live
list; a hook not on it ignores the variable entirely):

| Hook basename | What it normally does |
|---|---|
| `final-verification-evidence` | Blocks session Stop when the bound plan is fully checked off but no `final_verification` evidence entry has been logged for it. |
| `plan-continuation-guard` | Blocks session Stop when the bound plan still has unchecked numbered tasks, nudging the agent to keep going instead of stopping mid-plan. |
| `tool-loop-detector` | Warns when the same tool call repeats several times in a row, a common sign of a blind retry loop. |
| `write-guard` | Denies writes to protected paths — `verification-evidence.json` and anything under `.omca/notepads/` — on `Write`, `Edit`, and `MultiEdit` alike, and additionally warns before a `Write` call overwrites an existing file. |
| `git-destructive-deny` | Denies git subcommands that discard working-tree state: `reset --hard`, `stash`, `clean`, `restore`, `rm -r` (any clustered flag containing `r` or `R`), and a `checkout` whose arguments include a `--` pathspec separator. Matches at any command position and through an optional `sudo` prefix and leading git global options (`-C`, `-c`, `--git-dir`, `--work-tree`, `--no-pager`, and siblings). |
| `sed-grep-deny` | Denies `sed -n` and `grep -n` in Bash, including clustered short flags such as `-ne` or `-rn`, steering the agent to the Grep tool, `Read` with offset/limit, or `ast_search`. |
| `drift-guard` | Blocks session Stop when the last assistant turn reads as a completion claim but the working tree still contains stub markers on changed lines. |
| `plan-format-warn` | Warns when a plan file's checkboxes don't follow the numbered `- [ ] N.` form that progress tracking depends on. |
| `delegation-reminder` | One-time nudge to delegate to a specialist agent instead of doing repeated direct work in the main session. |
| `comment-checker` | Pre-write gate over comments in source files: flags AI attribution, narration that restates the next line, decorative separators, filler qualifiers, and context-free TODOs. Whether a finding blocks the write is set by [`OMCA_COMMENT_GATE`](#omca_comment_gate-the-comment-gates-enforcement-level). |
| `context-injector` | Injects nearby `AGENTS.md`/`README.md` excerpts and matching rule bodies (both plugin-shipped `rules/` and project `.omca/rules/`) when you read or edit a file. |

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

### `OMCA_COMMENT_GATE`: the comment gate's enforcement level

Selects how far `comment-checker` goes when it finds a slop comment in a source file you
are writing or editing. It is a separate axis from `OMCA_DISABLED_HOOKS`, which turns the
hook off entirely.

| Value | Behavior |
|---|---|
| `off` | The hook exits immediately. No findings, no advice, nothing recorded. |
| `advise` | **Default.** Shadow mode: the gate computes the same deny decision it would make under `deny`, records it, and then lets the write through with an advisory note instead of blocking. |
| `deny` | Blocks the write. AI-attribution and placeholder findings always block; heuristic findings block once per file-and-findings signature and then fail open, so a genuine non-obvious comment cannot trap an edit in a retry loop. |

Shadow-mode decisions are recorded to `.omca/logs/hook-info.jsonl` as `would-deny` entries
naming the tier and the file. Read those first to judge how the heuristics behave on your
own code, then switch to `deny` once the rate looks right:

```bash
OMCA_COMMENT_GATE=deny
```

### Other environment variables

| Variable | Purpose |
|---|---|
| `OMCA_PROBE_OUTPUT` | Output file path for the one-shot `UserPromptSubmit` payload capture script used during hook development. Not part of normal operation, and not registered as a permanent hook; only relevant if you are debugging the hook payload shape yourself. |

### Platform environment variables OMCA depends on

These are read by the client, not by OMCA. Scope for both is the session environment, or an
`env` block in a settings file; neither has a `/config` row.

| Variable | Purpose |
|---|---|
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | How many subagent layers may exist below the main conversation. At the limit the client withholds the `Agent` tool from the subagent entirely, so a planned delegation cannot happen at all: the agent does the work itself and returns one summary. A fork at the limit keeps the tool listed but it returns an error instead of spawning. Accepts a positive whole number in plain digits; anything else is ignored, so the limit can be adjusted but never removed. This is why OMCA's leaf agents are told to search inline rather than delegate. Requires client v2.1.217 |
| `CLAUDE_AFK_TIMEOUT_MS` | Idle milliseconds before an unanswered `AskUserQuestion` dialog auto-continues without you. Auto-continue is off by default and opts in through `askUserQuestionTimeout`, but this variable takes precedence and turns it on even when that setting is unset or `never`. That reintroduces exactly the hazard the `askUserQuestionTimeout` row above warns about: `prometheus` treats a skipped interview question as resolving to its default, so an auto-continued dialog silently shapes the plan. `0` does not disable the timeout, it closes the dialog immediately. `CLAUDE_AFK_COUNTDOWN_MS` sets when the on-screen countdown appears. Requires client v2.1.198 |

## Recommended settings.json blocks

These are opt-in blocks you add to your own `settings.json` (user or project scope, as
noted). None of them are applied automatically by the plugin.

### `/handoff` needs no settings block

Handoff ships with `disable-model-invocation: true`, so it only runs when you type
`/oh-my-claudeagent:handoff`. The `skillOverrides` block that used to be recommended here
did nothing: `skillOverrides` does not apply to plugin-shipped skills. The `handoff` keyword
still produces an advisory nudge toward the slash command; it does not start the workflow.

### Model and effort settings

| Setting | Suggested value | Why |
|---|---|---|
| `subagentPromptCacheTtl` | unset, or `"1h"` for long fan-outs | Scope: any settings file. Picks the prompt cache lifetime for every request outside the main conversation, which is exactly OMCA's traffic: subagents, workflows, compaction, and session titles. Values are `"5m"` and `"1h"`; unset leaves each request on its own default. `"1h"` keeps a parallel group's cache warm across a long task, and the API bills a one-hour cache write at a higher rate. Precedence, highest first: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, this key, `ENABLE_PROMPT_CACHING_1H`. Requires client v2.1.242 |
| `modelOverrides` | unset unless needed | The named escape hatch for provider portability. It maps individual Anthropic model ids to provider-specific ids. OMCA agents declare tier aliases (`opus`, `fable`), so map the versions those aliases resolve to on your provider rather than editing agent frontmatter |
| `availableModels` | unset unless your org requires it | This key alone constrains which models subagents and skills may select, independent of `enforceAvailableModels`. Filtering matches an alias, a version prefix, or a full provider-form id. The roster declares only `opus` and `fable`, so an allowlist omitting `opus` shuts out every agent but oracle, and one omitting `fable` shuts out oracle. An allowlist of `[sonnet, haiku]` now leaves nothing on the roster spawnable |
| `askUserQuestionTimeout` | leave at the default `never` | A timed-out question dialog is a silent auto-answer. `prometheus` treats a skipped interview question as resolving to that question's default, and `omca-setup` asks for confirmation before writing to `~/.claude/settings.json` |
| `workflowSizeGuideline` | unset | It bounds native dynamic workflows only and does not constrain direct `Agent` fan-out, so it cannot cap an OMCA parallel group. Setting it also hides the matching `/config` row |
| `emojiCompletionEnabled` | your preference | Cosmetic input-editor setting for `:shortcode:` completion. Not part of what `omca-setup` applies |

There is no longer a setting for a default teammate model. The key that did this was removed
in v2.1.234 along with its `/config` row, and a leftover value has no effect. Teammates now
follow the lead session's model unless the spawn names one.

Effort precedence, highest priority last: the `effortLevel` setting, then the session's
`--effort` flag or environment, then an agent's frontmatter `effort:`, then a per-invocation
override. OMCA depends on frontmatter winning over the settings default, so do not read
`effortLevel` as a hard ceiling. `fastMode` and `fastModePerSessionOptIn` sit alongside it and
have no OMCA consumer.

### Auto mode settings

`autoMode` and its sub-keys are read from **user settings, `--settings`, or managed settings
only**. They are not read from project `.claude/settings.json`, and as of v2.1.207 not from
`.claude/settings.local.json` either, so an `autoMode` block committed to a repo is a silent
no-op.

- `autoMode.environment` is free-text prose describing the machine the classifier is judging.
  Nobody but you can write it.
- Omitting the literal `"$defaults"` from an `autoMode` array replaces the built-in ruleset
  entirely, including the rule against transcript tampering.
- `disableAutoMode: "disable"` makes `permission-denied-coach.sh` unreachable, since the
  classifier never runs.
- `autoMode.classifyAllShell` (Boolean, default `false`, read from user or managed settings,
  the same sources as `autoMode` itself) sends every Bash and PowerShell command through the
  classifier while auto mode is active. Left off, auto mode suspends only the allow rules that
  could run arbitrary code, such as `Bash(*)` and `Bash(python *)`; a command matched by any
  narrower allow rule skips the classifier entirely. `/fewer-permission-prompts` and
  `omca-setup` both write rules of that narrower shape, so turning this on is what keeps those
  rules from becoming an unreviewed path. Requires client v2.1.193.
- `useAutoModeDuringPlan` (Boolean, default `true`) governs whether the planning agents' shell
  calls prompt one by one. Its scope is user, local, or managed settings, which is wider than
  `autoMode`'s own: a `.claude/settings.local.json` may set it even though the same file is
  never a source for `autoMode`. Shared project settings still cannot. Set `false` to get a
  prompt for every command outside the built-in read-only set.
- Inspect the effective ruleset with `claude auto-mode defaults`, `claude auto-mode config`,
  `claude auto-mode critique`, and `claude auto-mode reset`.

Auto mode is on by default on Bedrock, Vertex, and Foundry as of v2.1.207;
`CLAUDE_CODE_ENABLE_AUTO_MODE` is now only a way to force it on where a deployment turned it
off.

### Parameter-scoped permission rules

The `Tool(param:value)` permission syntax matches a tool call's own input, which makes three
forms useful for cost and blast-radius governance. None is set by the plugin.

```json
{
  "permissions": {
    "deny": [
      "Agent(model:fable)",
      "Agent(isolation:worktree)",
      "Bash(run_in_background:true)"
    ]
  }
}
```

Use the alias form (`opus`, `fable`) rather than a pinned id. The rule is matched against the
literal input Claude sends, before any normalization, and OMCA's delegation guidance passes the
alias when it passes a model at all, so the alias form fires on those calls and a pinned id does
not. `Agent(model:fable)` is the rule that bites hardest in practice, because a per-call `fable`
override is the one delegation that reaches beyond the roster's declared tier.

`Agent(model:...)` gates explicit per-call overrides only. An agent that takes its tier from
its own frontmatter is spawned with no `model` parameter at all, and an omitted parameter is
never matched, so no rule of this shape can cap the roster agents' declared tier. Use
`availableModels` for that.

Do not add `Write(<path>)`, `NotebookEdit(<path>)`, or `Glob(<path>)` rules. They are accepted
but never match, and the platform now prints a startup warning for each one. `Edit(<path>)`
covers every file-editing tool, including `Write`.

### Sandbox network settings

| Setting | Scope | What it does |
|---|---|---|
| `sandbox.network.strictAllowlist` | User or managed settings. A repository cannot turn it on or off | Boolean, default `false`. The fail-closed switch for the network allowlist: `true` denies a sandboxed command any host outside `sandbox.network.allowedDomains` plus the `WebFetch(domain:...)` allow rules, instead of falling back to the permission mode. Left at `false`, a host outside the allowlist is resolved by mode: the classifier judges it in auto mode, `dontAsk` denies, `bypassPermissions` allows, and anything else prompts. Enforced for sandboxed commands only; in-process tools such as `WebFetch` still follow their permission rules. Any honored source setting `true` keeps it on. Requires client v2.1.219 |

`sandbox.network.deniedDomains` is the blocklist half and takes precedence where both match.
This key is the one that makes the allowlist authoritative rather than advisory.

### Screen reader and accessibility

Set `CLAUDE_STATUSLINE_NERD_FONT=0` for plain-text statusline glyphs. The statusline still
emits ANSI color escapes unconditionally; see
[`docs/reference/known-issues.md`](known-issues.md).

### Worktree settings

These control how `isolation: worktree` agents and `/start-work --worktree` set up their
isolated git worktrees.

| Setting | Purpose |
|---|---|
| `worktree.symlinkDirectories` | Array of directory names (relative to the repo root) to symlink into each new worktree instead of copying them. Use this for `node_modules` or a large build cache that would otherwise be duplicated per worktree. **Windows floor v2.1.205**: below that version, following this recommendation on a Windows client could delete files outside the worktree on removal. |
| `worktree.sparsePaths` | Array of paths to check out via git sparse-checkout (cone mode) in each worktree. Only listed paths are written to disk, which speeds up worktree creation in large monorepos. Omit to check out the full tree. Below v2.1.207, removing such a worktree left `extensions.worktreeConfig` behind in the repo config, which breaks go-git-based tooling. |
| `worktree.baseRef` | Controls which ref a new worktree branches from: `"fresh"` (default) branches from `origin/<default-branch>`; `"head"` branches from local `HEAD`. See [`docs/reference/known-issues.md`](known-issues.md) for the unpushed-commits trap this setting controls. |
| `worktree.bgIsolation` | Scope: any settings file. How a background session isolates its file edits. `"worktree"` (default) blocks `Edit` and `Write` in the main checkout until the session calls `EnterWorktree`; `"none"` lets background jobs edit the working copy directly. This governs every spawned subagent, since a subagent runs in the background unless spawned with `run_in_background=false`, so at the default a delegated executor cannot write in the main checkout at all. Set `"none"` in a repository where git worktrees are impractical. |

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

Two rule directories exist and they load by different mechanisms. `.claude/rules/*.md` is
platform-loaded and gated on project settings being an included settings source for the
session, so it can be silently absent. `.omca/rules/*.md` is injected by
`context-injector.sh` on file access and always fires.

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
