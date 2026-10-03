---
name: omca-setup
description: "Use to install, check, repair or uninstall oh-my-claudeagent's setup in ~/.claude/ (dependencies, runtime, status line), or when the user says \"setup omca\"."
user-invocable: true
shell: bash
argument-hint: "[--uninstall | --check | --doctor]"
allowed-tools:
  - Read
  - Bash(claude --version)
  - Bash(bun --version)
  - Bash(ast-grep --version)
  - Bash(sg --version)
  - Bash(bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" *)
  - mcp__plugin_oh-my-claudeagent_omca__health_check
---

# omca-setup

Checks what OMCA needs, asks whether the terminal font draws Nerd Font icons, then points the status line and the subagent status line at OMCA's renderer. The only file outside the plugin it writes is the user settings file (the two status line keys and `env.OMCA_GLYPHS`), plus the launcher `omca/statusline.ts` beside it, and only after the user confirms the printed change. OMCA's server delivers the orchestration guidance on each session's first prompt, so setup writes nothing into `CLAUDE.md`.

The user settings directory is `$CLAUDE_CONFIG_DIR` when that variable is set and not empty, and `~/.claude` otherwise; the launcher goes under the same directory. In bash the settings file is `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"`. In PowerShell it is `"$(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { "$HOME\.claude" })\settings.json"`. `SETTINGS` below stands for that quoted path in the shell the session uses.

**Policy baseline**: Claude Code's native settings are authoritative. Managed settings are non-overridable policy, and keys such as `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly` and `sandbox.failIfUnavailable` belong there; this skill never writes or enforces them. OMCA's hooks never auto-allow a command, so allow decisions come from the permission rules in the user's settings, and `/fewer-permission-prompts` proposes them from past transcripts. The mod's guard denies catastrophic removals outright. For another destructive Bash command it asks in a review dialog when the `guardMode` option is `dialog` and a dialog can show; otherwise it denies a command that discards work.

## Mode detection

Parse `$ARGUMENTS`:

- `--uninstall`: UNINSTALL MODE
- `--check` or `--doctor`: tell the user to run `/omca doctor`, which reports the mod, the client and bun versions, the hooks, ast-grep, the plugin options, effort and model overrides, the advisor and the status line. Stop there.
- No flag: SETUP MODE

## Setup mode

### Phase 1: dependency check

Run each command and compare the version it prints:

```bash
claude --version
```

PASS at 2.1.288 or later. Otherwise FAIL and **stop**: OMCA's mod needs Claude Code 2.1.288 or later.

```bash
bun --version
```

PASS at 1.4.2 or later. Otherwise, including when bun is missing, FAIL and **stop**: OMCA's server, its hooks and the status line run on bun.

```bash
ast-grep --version
```

When `ast-grep` is missing, run `sg --version` instead. Either one is PASS. Neither is WARN, not a stop: only the structural code search tools need it.

### Phase 2: runtime check

Call the `health_check` tool, loading it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__health_check", max_results: 1})`. When `runtime` is `ok`, report PASS. Otherwise report the `runtime` value and `runtime_reason` verbatim, and continue: the status line works without the runtime. When the tool is still missing, OMCA's server is not connected; report that and continue.

### Phase 3: glyphs

The `/omca` pane, the band and the status line draw Nerd Font icons unless `OMCA_GLYPHS` names `unicode` or `ascii`. No surface can see the terminal's font, so ask.

1. Print this line exactly as written, so the user's terminal draws it: `   ` (a check in a circle, U+F05D, then gears, U+F085, an eye, U+F06E and a terminal prompt, U+F120).

2. Ask with `AskUserQuestion` whether they see four small icons or boxes and blanks. When they see the icons, report `nerd` and end the phase.

3. When they see boxes, preview the change:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --settings SETTINGS --glyphs unicode --glyphs-only
   ```

   It prints `Already configured: ...` when the settings already name `unicode`; report that and end the phase. Otherwise show the printed diff unchanged and ask with `AskUserQuestion` whether to apply it. On yes, run the same command with `--yes`; on no, change nothing and print the command. `unicode` keeps every pane and status line glyph inside common monospace fonts; `ascii` is for plain-text output and screen readers.

### Phase 4: status line

The `statuslineMode` plugin option is `${user_config.statuslineMode}`. Claude Code substitutes the option into this file only when the user has set it, so when that still reads as a placeholder instead of `off` or `on`, the default `on` applies. When it is `off`, skip this phase.

1. Preview the change:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --settings SETTINGS
   ```

   It writes nothing. It prints `Already configured: ...` when there is nothing to do; report that and end the phase. Otherwise it prints a unified diff of the settings file and the launcher it would copy. It sets `statusLine` to the absolute bun path plus the launcher's path with `padding: 1`, `refreshInterval: 5` and `hideVimModeIndicator: true`, and `subagentStatusLine` to the same command with `--subagent`. Any other `statusLine` or `subagentStatusLine` is replaced, and every other key and byte of the file stays as it is. When it exits 1, report its one-line reason and end the phase.

2. Show the user the printed diff unchanged, then ask with `AskUserQuestion` whether to apply it. Say that the previous file is kept beside it as `settings.json.omca-bak`.

3. On yes, apply it:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --settings SETTINGS --yes
   ```

   On no, change nothing and print that command so the user can run it later.

The launcher runs the renderer of the enabled plugin install that Claude Code recorded most recently, under any marketplace, so a plugin update needs no second setup run. In a `--plugin-dir` checkout, with no installed version, the status line reads `omca: no installed plugin version found`.

### Phase 5: force-style opt-out

The `disableForceOrchestrationStyle` option is `${user_config.disableForceOrchestrationStyle}`; a placeholder means the default `false`. When it is not `true`, skip this phase.

Only the installed cache copy is edited, because a `--plugin-dir` checkout is tracked source. When `${CLAUDE_PLUGIN_ROOT}` lies under `plugins/cache/` in the user settings directory, Read `${CLAUDE_PLUGIN_ROOT}/output-styles/omca-default.md`. If its frontmatter has the line `force-for-plugin: true`, remove that line with Edit and report that the user's own `outputStyle` now takes precedence. If the line is already gone, report that. A plugin update restores the line, so this phase has to run again after each update. Outside the cache, report that the opt-out applies only to an installed copy.

### Report

```
=== oh-my-claudeagent setup ===
Claude Code  PASS 2.1.288
bun          PASS 1.4.2
ast-grep     PASS 0.44.0 | WARN not found
Runtime      PASS | <runtime>: <runtime_reason>
Glyphs       nerd | unicode written | already unicode | declined
Status line  configured | already configured | declined | off | <reason>
Force style  stripped | already stripped | skipped
```

## Uninstall mode

1. Preview what setup wrote:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --settings SETTINGS --uninstall
   ```

   It removes a `statusLine` or `subagentStatusLine` only when it runs OMCA's launcher, the launcher file itself, and `OMCA_GLYPHS` from `env`. When it prints `Nothing to remove: ...`, report that and go to step 3.

2. Show the diff, ask with `AskUserQuestion`, and on yes run the same command with `--yes`.

3. Tell the user that the plugin itself is removed with `/plugin uninstall oh-my-claudeagent@omca`, and its marketplace with `/plugin marketplace remove omca`. This skill does not run either, and it leaves `.omca/` in each project alone.

## Constraints

- Write only through `scripts/setup-statusline.ts`, after the user confirms the diff it printed, and through the Edit in phase 5.
- Never edit project, local or managed settings.
- A second run changes nothing that is already configured.
