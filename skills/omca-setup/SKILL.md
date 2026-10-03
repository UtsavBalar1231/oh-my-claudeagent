---
name: omca-setup
description: Configure ~/.claude/ for oh-my-claudeagent (dependency and runtime checks, and the status line through OMCA's launcher).
when_to_use: |
  Use when:
  - Installing or updating oh-my-claudeagent for the first time
  - User says "setup omca", "configure omca", or "install oh-my-claudeagent"
  - Diagnosing a broken or misconfigured plugin (--check, --doctor)
  - Uninstalling the plugin (--uninstall)
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

Checks what OMCA needs, then points the status line and the subagent status line at OMCA's renderer. The only file outside the plugin it writes is `~/.claude/settings.json` (two keys), plus the launcher at `~/.claude/omca/statusline.ts`, and only after the user confirms the printed change. OMCA's server delivers the orchestration guidance on each session's first prompt, so setup writes nothing into `CLAUDE.md`.

**Policy baseline**: Claude Code's native settings are authoritative. `teammateMode: "auto"` is normal. Managed settings are non-overridable policy, and keys such as `allowManagedPermissionRulesOnly`, `allowManagedHooksOnly` and `sandbox.failIfUnavailable` belong there; this skill never writes or enforces them. OMCA's hooks never auto-allow a command, so allow decisions come from the permission rules in the user's settings, and `/fewer-permission-prompts` proposes them from past transcripts. Its mod and hooks ask in a review dialog before a destructive Bash command runs and deny catastrophic removals outright.

## Mode detection

Parse `$ARGUMENTS`:

- `--uninstall`: UNINSTALL MODE
- `--check` or `--doctor`: tell the user to run `/omca doctor`, which reports the mod, the client and bun versions, the hooks, ast-grep, the plugin options, effort and model overrides, the advisor and the status line. Stop there.
- No flag: SETUP MODE

## SETUP MODE

### Phase 1: Dependency check

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

### Phase 2: Runtime check

Call the `health_check` tool, loading it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__health_check", max_results: 1})`. When `runtime` is `ok`, report PASS. Otherwise report the `runtime` value and `runtime_reason` verbatim, and continue: the status line works without the runtime. When the tool is still missing, OMCA's server is not connected; report that and continue.

### Phase 3: Status line

The `statuslineMode` plugin option is `${user_config.statuslineMode}`. Claude Code substitutes the option into this file only when the user has set it, so when that still reads as a placeholder instead of `off` or `on`, the default `on` applies. When it is `off`, skip this phase.

1. Preview the change:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --settings ~/.claude/settings.json
   ```

   It writes nothing. It prints `Already configured: ...` when there is nothing to do; report that and end the phase. Otherwise it prints a unified diff of `~/.claude/settings.json` and the launcher it would copy. It sets `statusLine` to the absolute bun path plus `~/.claude/omca/statusline.ts` with `padding: 1`, `refreshInterval: 5` and `hideVimModeIndicator: true`, and `subagentStatusLine` to the same command with `--subagent`. Any other `statusLine` or `subagentStatusLine` is replaced, and every other key and byte of the file stays as it is. When it exits 1, report its one-line reason and end the phase.

2. Show the user the printed diff unchanged, then ask with `AskUserQuestion` whether to apply it. Say that the previous file is kept as `~/.claude/settings.json.omca-bak`.

3. On yes, apply it:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --settings ~/.claude/settings.json --yes
   ```

   On no, change nothing and print that command so the user can run it later.

The launcher runs the renderer from the newest installed plugin version, so a plugin update needs no second setup run. In a `--plugin-dir` checkout, with no installed version, the status line reads `omca: no installed plugin version found`.

### Phase 4: Force-style opt-out

The `disableForceOrchestrationStyle` option is `${user_config.disableForceOrchestrationStyle}`; a placeholder means the default `false`. When it is not `true`, skip this phase.

Only the installed cache copy is edited, because a `--plugin-dir` checkout is tracked source. When `${CLAUDE_PLUGIN_ROOT}` lies under `~/.claude/plugins/cache/`, Read `${CLAUDE_PLUGIN_ROOT}/output-styles/omca-default.md`. If its frontmatter has the line `force-for-plugin: true`, remove that line with Edit and report that the user's own `outputStyle` now takes precedence. If the line is already gone, report that. A plugin update restores the line, so this phase has to run again after each update. Outside the cache, report that the opt-out applies only to an installed copy.

### Report

```
=== oh-my-claudeagent setup ===
Claude Code  PASS 2.1.288
bun          PASS 1.4.2
ast-grep     PASS 0.44.0 | WARN not found
Runtime      PASS | <runtime>: <runtime_reason>
Status line  configured | already configured | declined | off | <reason>
Force style  stripped | already stripped | skipped
```

## UNINSTALL MODE

1. Preview what setup wrote:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/setup-statusline.ts" --settings ~/.claude/settings.json --uninstall
   ```

   It removes a `statusLine` or `subagentStatusLine` only when it runs OMCA's launcher, and the launcher file itself. When it prints `Nothing to remove: ...`, report that and go to step 3.

2. Show the diff, ask with `AskUserQuestion`, and on yes run the same command with `--yes`.

3. Tell the user that the plugin itself is removed with `/plugin uninstall oh-my-claudeagent@omca`, and its marketplace with `/plugin marketplace remove omca`. This skill does not run either, and it leaves `.omca/` in each project alone.

## Constraints

- Write only through `scripts/setup-statusline.ts`, after the user confirms the diff it printed, and through the Edit in phase 4.
- Never edit project, local or managed settings.
- A second run changes nothing that is already configured.
