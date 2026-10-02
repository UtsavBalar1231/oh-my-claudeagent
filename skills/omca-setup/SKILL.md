---
name: omca-setup
description: Configure ~/.claude/ for oh-my-claudeagent (dependency checks for Claude Code, bun and ast-grep, settings and statusline setup).
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
  - Glob
  - Grep
  - Bash(command -v *)
  - Bash(jq *)
  - Bash(uv --version)
  - Bash(bun --version)
  - Bash(claude --version)
  - Bash(ast-grep --version)
  - Bash(sg --version)
  - Bash(git rev-parse *)
  - Bash(claude mcp list)
---

# omca-setup: Plugin Configuration

One-command setup: check dependencies, inspect plugin state, configure settings and the statusline, print rollout guidance. OMCA's server delivers the orchestration guidance itself on each session's first prompt, so setup writes nothing into `CLAUDE.md`.

**Out of scope**: marketplace install commands, auto-registering in `~/.claude/settings.json`, editing shared/managed settings, enforcing enterprise policy keys (`strictKnownMarketplaces`, `blockedMarketplaces`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`).

**Policy baseline**: Claude Code native settings are authoritative. `teammateMode: "auto"` is normal. Managed settings are non-overridable policy. OMCA does not auto-allow arbitrary commands. Its destructive-Bash guard asks in a review dialog before a destructive command runs and denies catastrophic removals outright. Where no dialog can show, it denies destructive git commands and lets other recursive removals run. When a permission prompt is about to appear, OMCA's server auto-approves only a short trusted-tooling list (`npm`, `bun`, `yarn`, and `pnpm` with `run`, `test`, `ci`, `list`, or `view`; `jq` without `--rawfile`; `uv run`; `uv sync`) and never a compound command.

**Install/update flow**:

- Install: `/plugin marketplace add UtsavBalar1231/oh-my-claudeagent` then `/plugin install oh-my-claudeagent@omca`
- Update: `/plugin marketplace update omca` then `/plugin install oh-my-claudeagent@omca`
- Apply in-session: Claude Code reloads plugins itself after a `/plugin` install or update. Run `/reload-plugins` (with `--force` if it warns about the prompt cache) only when the install summary says a change is still pending, or after a `claude plugin` command run in another terminal.
- `/reload-skills` re-scans skill directories only.

**`--bare` caveat**: `claude --bare` skips plugin, hooks, skills, MCP, and CLAUDE.md auto-discovery. Run setup in normal (non-`--bare`) sessions.

**Plugin options**:

- `enableKeywordTriggers`: bool, default `false`
- `statuslineMode`: `off|direct|daemon`, default `direct`
- `disableForceOrchestrationStyle`: bool, default `false`. Strips `force-for-plugin: true` from the installed style cache copy so your own `outputStyle` takes precedence; re-run setup after each plugin update.

**Sandbox**: For fail-closed environments, use `sandbox.failIfUnavailable: true` in managed settings. This skill reports sandbox posture but does not bypass host enforcement.

**Output style**: `output-styles/omca-default.md` (manifest `"outputStyles": "./output-styles/"`).

---

## Mode Detection

Parse `$ARGUMENTS` for flags:
- `--uninstall` → jump to UNINSTALL MODE
- `--check` → jump to CHECK MODE
- `--doctor` → jump to DOCTOR MODE (this skill's own OMCA-scoped read-only report, not the built-in `/doctor`)
- No flag → SETUP MODE (default)

---

## SETUP MODE

### Phase 1: Dependency Check

Run these checks in parallel:

```bash
claude --version
```
→ PASS at 2.1.287 or later, else FAIL. On FAIL, **STOP**: OMCA's mod needs Claude Code 2.1.287 or later.

```bash
command -v bun && bun --version
```
→ PASS at 1.4.2 or later, else FAIL. On FAIL, **STOP**: OMCA's MCP server and its hooks run on bun.

```bash
if command -v ast-grep >/dev/null 2>&1; then ast-grep --version 2>&1 | head -1; else command -v sg >/dev/null 2>&1 && sg --version 2>&1 | head -1; fi
```
→ PASS/WARN (optional; needed for structural code search MCP tools; accepts either `ast-grep` or `sg`)

Record each result (binary path + version or "not found") for the health report. The settings phases below edit JSON with `jq`; where `jq` is missing, make the same change with Read and Edit.

---

### Phase 2: Read Plugin Version

1. Determine the plugin root. Claude Code substitutes the loaded plugin's path into this file, so the value is `${CLAUDE_PLUGIN_ROOT}`. The Bash tool has no `CLAUDE_PLUGIN_ROOT` variable and keeps no shell state between calls, so start every command that uses `PLUGIN_ROOT` with:
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
   ```

2. Read the plugin version:
   ```
   Read("${PLUGIN_ROOT}/.claude-plugin/plugin.json")
   ```
   Extract the `version` field with jq.

---

### Phase 3: Registration Inspection and Rollout Guidance

1. Read `~/.claude/settings.json` if it exists; otherwise treat user-scope settings as absent.

2. Inspect setup state without modifying settings:
   - Check whether `enabledPlugins` contains a key starting with `oh-my-claudeagent` → report "already enabled in user settings"
   - Check whether the active plugin root lives under `~/.claude/plugins/cache/` → report "running from marketplace cache copy"
   - Check whether the current session was loaded via `--plugin-dir` or another checkout outside the cache → report "running from local checkout / development mode"
   - Check whether a legacy `plugins` array entry contains `oh-my-claudeagent` → report "legacy git-clone install detected"

3. If the plugin is not already enabled in user settings, print install guidance instead of writing settings:
   ```
   Plugin not enabled in user settings. Use one of these Claude Code-supported paths:

     /plugin marketplace add UtsavBalar1231/oh-my-claudeagent
     /plugin install oh-my-claudeagent@omca

   Or add the shared-team snippet to .claude/settings.json:

   {
     "extraKnownMarketplaces": {
       "omca": {
         "source": {
           "source": "github",
           "repo": "UtsavBalar1231/oh-my-claudeagent"
         }
       }
     },
     "enabledPlugins": {
       "oh-my-claudeagent@omca": true
     }
    }
    ```

   Ownership boundary: this skill inspects `~/.claude/settings.json` and prints install snippets, but does not register the plugin automatically.

4. Print enterprise rollout guidance (inspection only; do not write or enforce):
   - `strictKnownMarketplaces`, accepted alias `allowedMarketplaces` → allow only admin-approved marketplaces
   - `blockedMarketplaces` → explicitly deny marketplaces that should never resolve
   - `allowManagedHooksOnly` → allow only hooks defined in managed settings
   - `allowManagedPermissionRulesOnly` → allow only managed permission rules
   - `allowManagedMcpServersOnly` → allow only managed MCP server definitions
   - `sandbox.failIfUnavailable` → fail closed if the sandbox cannot be applied

   These keys belong in managed settings when the organization needs non-overridable policy. This skill only points the user/admin at them. Marketplace-installed copies run from `~/.claude/plugins/cache/...`.

---

### Phase 4: Settings Configuration

Apply optional user-scope helper settings to `~/.claude/settings.json` with user confirmation.

1. Read `~/.claude/settings.json` (if exists; if not, start with `{}`)

2. Detect managed-policy lock keys in current scope (`allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`). If present and true, do not propose local permission-rule writes; report that managed policy owns permission enforcement.

3. Compute missing optional helper permissions against the recommended set:
   - `Edit(.omca/**)`, `Read(.omca/**)`
   - `mcp__plugin_oh-my-claudeagent_omca__*`, `mcp__plugin_oh-my-claudeagent_grep__*`, `mcp__plugin_oh-my-claudeagent_context7__*`

4. This skill writes no top-level keys and no `env` entries. These in particular are left to the user:

   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, and with it `teammateMode: "auto"`, which is inert unless that variable is set. With agent teams enabled, any subagent Claude names silently launches as a teammate instead, so `subagent_type` routing and OMCA's per-agent accounting stop describing what actually ran. OMCA's model is fan-out-and-read-results against that accounting, so setup neither sets the variable nor warns when it is absent. Users who want teams set it themselves.
   - `ANTHROPIC_DEFAULT_OPUS_MODEL` and its `SONNET`/`FABLE` siblings. Each takes a full model name, never an alias, so setting one pins a generation that goes stale. OMCA agents declare the tier alias in their own frontmatter and let the platform resolve it, which is what these keys would otherwise override.
   - `advisorModel`. OMCA's prompts consult the advisor at their checkpoints when it is on, but choosing it is a billing decision: a Fable advisor bills to usage credits on some plans, behind a one-time consent that only `/model fable` records. Point the user at `/advisor fable`, or `/advisor opus` without Fable access, and let `--doctor` report what would keep it off.

5. If all present: "Settings already configured" -- skip

6. If changes needed: show diff, use `AskUserQuestion` to confirm

7. On confirm: read-merge-write with `jq` (handle nonexistent file)

8. On decline: print raw jq command as fallback:
   ```
   tmp=$(mktemp ~/.claude/settings.json.XXXXXX) && jq '.permissions.allow += [
     "Edit(.omca/**)",
     "Read(.omca/**)",
     "mcp__plugin_oh-my-claudeagent_omca__*",
     "mcp__plugin_oh-my-claudeagent_grep__*",
     "mcp__plugin_oh-my-claudeagent_context7__*"
   ]' ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json
   ```

9. Explain each setting:
    - `Edit(.omca/**)` / `Read(.omca/**)`: auto-allow plugin state file access. `Edit` covers every file-editing tool including `Write`; a `Write(path)` rule is accepted but never matched by the file permission checks and makes Claude Code print a startup warning, so do not add one.
    - `mcp__plugin_oh-my-claudeagent_omca__*` / `mcp__plugin_oh-my-claudeagent_grep__*` / `mcp__plugin_oh-my-claudeagent_context7__*`: auto-allow bundled MCP tool usage. A plugin-bundled server's tools carry the plugin name in their prefix, HTTP servers included, so the bare `mcp__grep__*` and `mcp__context7__*` forms never match them.
    - These are optional local helper allowances; managed settings remain the policy authority.

---

### Phase 5: Statusline Setup

Configure the Claude Code statusline to use the oh-my-claudeagent statusline package.

1. Read `~/.claude/settings.json` (if it exists; otherwise treat as `{}`).

2. Check if `statusLine` is already configured. Three-way branch:
   - **(a) Both fields present**: If `settings.statusLine` is present AND both `hideVimModeIndicator == true` AND `refreshInterval` is present → print "statusLine already configured; skipping" and skip this phase.
   - **(b) `refreshInterval` missing**: If `settings.statusLine` is present AND `hideVimModeIndicator == true` but `refreshInterval` is absent → DO NOT skip; jump to step 6 to back-fill `refreshInterval`.
   - **(c) `hideVimModeIndicator` missing or false**: If `settings.statusLine` is present but `hideVimModeIndicator` is missing or `false` → DO NOT skip; jump to step 6 to back-fill both fields. Existing installs without either field are not stranded; step 6 handles both.

3. If not configured, first resolve the `statuslineMode` plugin option in prose, not in the shell. Claude Code substitutes a plugin option into this file only when the user has set it, so the value is: `${user_config.statuslineMode}`. If that still shows the placeholder text instead of `off`, `direct`, or `daemon`, the option is unset and its plugin.json default, `direct`, applies. Never copy the placeholder into a bash command: unsubstituted, it is a "bad substitution" error. When the resolved mode is `off`, skip this phase. Otherwise use `AskUserQuestion` to ask:
   ```
   Enable the oh-my-claudeagent statusline? It shows model, context bar, cost, duration, git status, and more in your terminal.
   [y/N]
   ```

4. On decline: skip this phase silently.

5. On confirm, run `command -v uv` first. The statusline package needs `uv`; when it is missing, tell the user so and skip this phase.

   a. **Resolve the plugin root**: use `PLUGIN_ROOT` from Phase 2, the root this session loaded. Do not glob the cache for the newest version directory: a string sort ranks `2.9.0` above `2.19.1`, and a `--plugin-dir` checkout is not in the cache at all.

   b. **Create the deployment structure** at `~/.claude/statusline/`:

      Layout:
      ```
      ~/.claude/statusline/
        pyproject.toml              ← copied from <plugin-root>/statusline/pyproject.toml
        statusline/                 ← all *.py copied from <plugin-root>/statusline/
        servers/                    ← sibling dependency; NOT a package (no __init__.py)
          tools/
            __init__.py             ← copied from <plugin-root>/servers/tools/
            _boulder_core.py        ← copied from <plugin-root>/servers/tools/
      ```

      The `servers/tools/` sibling is load-bearing: `statusline/core.py` imports
      `tools._boulder_core` (the boulder-registry resolver) by adding the sibling
      `servers/` directory to `sys.path` at import time (`__file__/../../servers`).
      Without it, `cc-statusline` silently falls back to the `[claude]` stub and
      `cc-statusline-subagent` crashes with `ModuleNotFoundError: No module named
      'tools'`. `_boulder_core.py` has zero third-party imports and is the only
      `tools.*` reference in the statusline package, so those two files are the
      complete closure.

      Commands (replace `<plugin-root>` with the path from step a):
      ```bash
      mkdir -p ~/.claude/statusline/statusline ~/.claude/statusline/servers/tools
      cp <plugin-root>/statusline/pyproject.toml ~/.claude/statusline/pyproject.toml
      cp <plugin-root>/statusline/*.py ~/.claude/statusline/statusline/
      cp <plugin-root>/servers/tools/__init__.py <plugin-root>/servers/tools/_boulder_core.py \
        ~/.claude/statusline/servers/tools/
      ```

   c. **Run `uv sync`** to create the venv and install entry points:
      ```bash
      uv sync --project ~/.claude/statusline
      ```

   d. **Choose the mode.** Use the mode resolved in step 3 when it is `direct` or `daemon`, without asking: that is the mode the user configured, or the plugin default. Only when it resolved to something else, ask using `AskUserQuestion`:
      ```
      Statusline mode?
        1. Daemon (fastest, <1ms warm response) [recommended]
        2. Direct (simpler, ~20ms response)
      ```
      Default to daemon (option 1) if the user picks 1 or confirms without a specific choice.

   e. **Set the settings.json command** based on mode:
      - Daemon: `~/.claude/statusline/.venv/bin/cc-statusline`
      - Direct: `~/.claude/statusline/.venv/bin/cc-statusline-direct`

      Use jq to merge atomically (read-merge-write). Set `hideVimModeIndicator: true`
      because the OMCA statusline already renders `vim.mode` on line 1. Without
      this flag the platform draws a redundant `-- INSERT --` row beneath the
      statusLine output (see `https://code.claude.com/docs/en/statusline` for the
      `hideVimModeIndicator` field). Set `refreshInterval: 5` so the statusline
      re-polls disk-sourced state (git metadata, boulder plan) on a 5-second cadence;
      this keeps the display fresh while the main session sits idle during
      background-agent fan-outs, where the coordinator is waiting rather than actively
      generating. The value 5 matches the statusline's git cache TTL (5 s), so each
      refresh tick can pick up a newly cached git snapshot without triggering redundant
      subprocess calls.

      ```bash
      tmp=$(mktemp ~/.claude/settings.json.XXXXXX) \
        && jq --arg cmd "<chosen-command>" '. + {"statusLine": {"type": "command", "command": $cmd, "padding": 1, "hideVimModeIndicator": true, "refreshInterval": 5}}' \
        ~/.claude/settings.json > "$tmp" \
        && mv "$tmp" ~/.claude/settings.json
      ```
      If `~/.claude/settings.json` does not exist, create it from `{}`:
      ```bash
      echo '{}' | jq --arg cmd "<chosen-command>" '. + {"statusLine": {"type": "command", "command": $cmd, "padding": 1, "hideVimModeIndicator": true, "refreshInterval": 5}}' \
        > ~/.claude/settings.json
      ```

   e2. **Also configure `subagentStatusLine`** (separate platform hook) so each spawned subagent's row in the tasks panel shows its real name, model, status, and token count. Unlike `statusLine`, this has no daemon variant: it always points at the direct-mode entry point. Skip if `settings.subagentStatusLine` is already present:

      ```bash
      tmp=$(mktemp ~/.claude/settings.json.XXXXXX) \
        && jq 'if .subagentStatusLine then . else . + {"subagentStatusLine": {"type": "command", "command": "~/.claude/statusline/.venv/bin/cc-statusline-subagent"}} end' \
        ~/.claude/settings.json > "$tmp" \
        && mv "$tmp" ~/.claude/settings.json
      ```

   f. **For daemon mode only**: start the daemon, then verify it came up:
      ```bash
      ~/.claude/statusline/.venv/bin/cc-statusline-daemon start
      sleep 0.05
      if ! ~/.claude/statusline/.venv/bin/cc-statusline-daemon status > /dev/null 2>&1; then
          # retry once
          ~/.claude/statusline/.venv/bin/cc-statusline-daemon start
          sleep 0.1
          if ! ~/.claude/statusline/.venv/bin/cc-statusline-daemon status > /dev/null 2>&1; then
              echo "[omca-setup] warning: statusline daemon failed to start; client will use direct mode" >&2
          fi
      fi
      ```

   g. Report to user:
      ```
      Statusline configured:
        ~/.claude/statusline/pyproject.toml       - package manifest
        ~/.claude/statusline/statusline/          - package files (copied from plugin)
        ~/.claude/statusline/servers/tools/       - boulder-resolver sibling (core.py dependency)
        ~/.claude/statusline/.venv/               - uv-managed venv with entry points
        ~/.claude/settings.json                   - statusLine added (mode: daemon|direct, refreshInterval: 5)
        ~/.claude/settings.json                   - subagentStatusLine added (cc-statusline-subagent, direct mode)

      For daemon mode: daemon started (auto-starts on first request if not running)
      Restart Claude Code to activate the statusline.

      Note: After plugin updates, re-copy the files and re-run uv sync to pick up changes:
        cp <plugin-root>/statusline/pyproject.toml ~/.claude/statusline/pyproject.toml
        cp <plugin-root>/statusline/*.py ~/.claude/statusline/statusline/
        cp <plugin-root>/servers/tools/__init__.py <plugin-root>/servers/tools/_boulder_core.py \
          ~/.claude/statusline/servers/tools/
        uv sync --project ~/.claude/statusline
      Or simply re-run /oh-my-claudeagent:omca-setup (it will skip already-configured phases).
      ```

   h. **Note**: If an old `~/.claude/statusline.py` wrapper script exists, it can be removed; it is superseded by this copy-based deployment.

6. **Back-fill `hideVimModeIndicator` and `refreshInterval` on existing statusLine** (entered when step 2 detected `statusLine` present but one or both fields are missing):

   Two fields may need back-filling independently. Ask for consent once, covering both:

   The OMCA statusline already renders `vim.mode` on line 1; without
   `hideVimModeIndicator: true` the platform draws a redundant `-- INSERT --` row
   beneath the user's statusLine output. Additionally, `refreshInterval: 5` keeps
   disk-sourced state (git metadata, boulder plan) fresh while the session sits idle
   during background-agent fan-outs; without it the statusline only updates on active
   keystrokes. Ask via `AskUserQuestion` (only when at least one field is absent):
   ```
   Your existing statusLine config is missing one or more OMCA-recommended fields.
   Proposed additions:
     hideVimModeIndicator: true  - suppresses redundant '-- INSERT --' row (OMCA renders vim mode itself)
     refreshInterval: 5          - re-polls disk-sourced state every 5 s during idle background-agent runs

   This changes your statusLine's execution cadence. Add the missing field(s)? [Y/n]
   ```

   On confirm, atomic jq update (idempotent: only adds each field when absent, so a
   second run produces a byte-identical result):
   ```bash
   tmp=$(mktemp ~/.claude/settings.json.XXXXXX) && jq '
     if .statusLine.hideVimModeIndicator == null then .statusLine.hideVimModeIndicator = true else . end |
     if .statusLine.refreshInterval == null then .statusLine.refreshInterval = 5 else . end
   ' ~/.claude/settings.json \
     > "$tmp" \
     && mv "$tmp" ~/.claude/settings.json
   ```

   On decline: skip silently.

7. **Known platform limitation (permission mode banner)**: the `›› bypass permissions on (shift+tab to cycle)` indicator on the same native row has no documented opt-out. Only the vim half is suppressible via `hideVimModeIndicator`. Document this in the report so users know the residual line is a platform feature, not an OMCA bug.

---

### Phase 6: Force-Style Opt-Out

Apply or skip the `disableForceOrchestrationStyle` opt-out based on the user's plugin config.

1. Resolve the option in prose, not in the shell. Claude Code substitutes a plugin option into this file only when the user has set it, so the value is: `${user_config.disableForceOrchestrationStyle}`. If that still shows the placeholder text instead of `true` or `false`, the option is unset and its plugin.json default, `false`, applies. Never copy the placeholder into a bash command: unsubstituted, it is a "bad substitution" error. The `CLAUDE_PLUGIN_OPTION_*` variables reach hook processes only, never this shell. Call the resolved value `OPT_OUT` below.

2. Read the plugin version from `${PLUGIN_ROOT}/.claude-plugin/plugin.json`:
   ```bash
   PLUGIN_VERSION=$(jq -r '.version' "${PLUGIN_ROOT}/.claude-plugin/plugin.json")
   ```

3. Locate the installed cache copy of the style file. On a marketplace install `PLUGIN_ROOT` is that copy, `~/.claude/plugins/cache/<marketplace>/oh-my-claudeagent/<version>/`:
   ```bash
   case "${PLUGIN_ROOT}" in
     "${HOME}"/.claude/plugins/cache/*) STYLE_FILE="${PLUGIN_ROOT}/output-styles/omca-default.md" ;;
     *) STYLE_FILE="" ;;
   esac
   ```
   If `STYLE_FILE` is empty or the file does not exist, skip this phase and note to user: "output-styles/omca-default.md not found in plugin cache; skipping force-style opt-out (development mode or non-standard install path)." A `--plugin-dir` checkout is skipped on purpose, because stripping there would edit tracked source.

4. Locate the sidecar state file in the plugin's persistent data directory, which survives plugin updates:
   ```bash
   SIDECAR="${CLAUDE_PLUGIN_DATA}/force-strip-state.json"
   ```

5. **If `OPT_OUT` is `true` or `1`**:

   a. Read the style file mtime:
      ```bash
      FILE_MTIME=$(bun -e 'console.log(Math.trunc(require("node:fs").statSync(process.argv[1]).mtimeMs / 1000))' "${STYLE_FILE}")
      ```

   b. Read the sidecar (if it exists) to check whether the strip was already applied to the current file version:
      ```bash
      if [ -f "${SIDECAR}" ]; then
        APPLIED_MTIME=$(jq -r '.applied_at_mtime // 0' "${SIDECAR}")
        APPLIED_VER=$(jq -r '.version // ""' "${SIDECAR}")
      else
        APPLIED_MTIME=0
        APPLIED_VER=""
      fi
      ```

   c. **Already applied and file unchanged**: if `APPLIED_MTIME == FILE_MTIME` and `APPLIED_VER == PLUGIN_VERSION`, print "force-style strip already applied; no-op." and skip to step 6.

   d. **Apply the strip**: remove the `force-for-plugin: true` line (a bun one-liner avoids GNU/BSD sed differences):
      ```bash
      bun -e 'const fs = require("node:fs"); const p = process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/^force-for-plugin: true\n/gm, ""))' "${STYLE_FILE}"
      ```
      Idempotent: if the line is already absent, the substitution is a no-op.

   e. **Update the sidecar** (atomic write):
      ```bash
      NEW_MTIME=$(bun -e 'console.log(Math.trunc(require("node:fs").statSync(process.argv[1]).mtimeMs / 1000))' "${STYLE_FILE}")
      bun -e 'require("node:fs").writeFileSync(process.argv[3], JSON.stringify({ applied_at_mtime: Number(process.argv[1]), version: process.argv[2] }) + "\n")' "${NEW_MTIME}" "${PLUGIN_VERSION}" "${SIDECAR}"
      ```

   f. Report to user:
      ```
      force-for-plugin: true stripped from output-styles/omca-default.md (cache copy v${PLUGIN_VERSION}).
      Your own outputStyle setting will take precedence.
      Sidecar: ${CLAUDE_PLUGIN_DATA}/force-strip-state.json
      Note: re-run /oh-my-claudeagent:omca-setup after each plugin update to re-apply the strip.
      ```

6. **If `OPT_OUT` is unset, `false`, or `0`**: skip silently; no changes to the style file.

---

### Phase 7: Detect outputStyle Degraded Mode

OMCA's orchestration body lives in `output-styles/omca-default.md` with
`force-for-plugin: true`, which per the platform spec
(https://code.claude.com/docs/en/output-styles) "overrides the user's
outputStyle setting." In practice this works for most setups, but two
configurations can still leave OMCA running in degraded mode:

- An explicit user-scope `outputStyle` pin in `~/.claude/settings.json` set to
  something other than `"OMCA Default"`, where the user expects OMCA to win
  but is observing a different active style (typically because another
  enabled plugin also declares `force-for-plugin: true` and loads first;
  plugin load order is opaque).
- An explicit Project-scope or Local-scope `outputStyle` in
  `.claude/settings.json` / `.claude/settings.local.json`. The spec text
  says `force-for-plugin` overrides the user's setting, but does not cover
  the higher-precedence scopes.

A user-scope pin naming a built-in style does not suppress OMCA's own
`force-for-plugin` style, not even on the first turn of a fresh session. Report a pin as a suspected cause only. Clearing it is a
diagnostic step whose effect on the active style is unconfirmed.

This phase detects both conditions and offers a fix. It does NOT touch
settings unless the user confirms.

1. Read `~/.claude/settings.json` (treat as `{}` if absent).

2. Extract `outputStyle`:
   ```bash
   PINNED=$(jq -r '.outputStyle // empty' ~/.claude/settings.json 2>/dev/null)
   ```

   Also read the two higher-precedence scopes in the current project, which the user-scope read cannot see:
   ```bash
   LOCAL_PIN=$(jq -r '.outputStyle // empty' .claude/settings.local.json 2>/dev/null)
   PROJECT_PIN=$(jq -r '.outputStyle // empty' .claude/settings.json 2>/dev/null)
   ```
   If either is set, report it with its file name as a degraded-mode cause alongside whichever branch below applies. This skill does not edit project settings, so point the user at the file.

3. Scan all installed plugins for `force-for-plugin: true` output styles
   that are NOT OMCA's own:
   ```bash
   COMPETITORS=$(grep -lrE '^force-for-plugin: true' ~/.claude/plugins/cache/ 2>/dev/null \
     | grep -v "/oh-my-claudeagent/" \
     | sort -u)
   ```

4. **Branch A: clean state** (`PINNED` empty AND no competitors):
   Print `outputStyle: OMCA Default will load via force-for-plugin (no conflicts detected)` and skip.

5. **Branch B: pin to OMCA Default already**: if `PINNED == "OMCA Default"`,
   print `outputStyle already pinned to OMCA Default` and skip.

6. **Branch C: non-OMCA pin set**: if `PINNED` is set and not
   `"OMCA Default"`:

   a. Report the conflict:
      ```
      outputStyle DEGRADED-MODE WARNING:
        User settings pin outputStyle to "${PINNED}".
        OMCA's force-for-plugin: true should override this per spec, but if
        you are observing the pinned style winning in active sessions, the
        likely cause is another plugin shipping the same flag and loading
        first.
      ```

   b. List competitors if any:
      ```
      Other plugins declaring force-for-plugin: true:
        <list>
      Plugin load order is not user-configurable; the first one loaded wins.
      ```

   c. Ask the user via `AskUserQuestion`:
      ```
      Clear the outputStyle pin from ~/.claude/settings.json? OMCA's
      force-for-plugin will then be the only signal selecting an output
      style. A style selected mid-session applies from the next message, so no restart is needed to switch. Only creating or
      editing a style file needs one, because Claude Code reads style
      files at startup.
      [Recommended: Yes when no other plugin is competing]
      ```

   d. On confirm: atomic delete via jq:
      ```bash
      tmp=$(mktemp ~/.claude/settings.json.XXXXXX) \
        && jq 'del(.outputStyle)' ~/.claude/settings.json > "$tmp" \
        && mv "$tmp" ~/.claude/settings.json
      ```
      Report: `Cleared outputStyle pin. OMCA Default applies from the next message.`

   e. On decline: print the fallback command so the user can run it later
      and continue without modifying settings:
      ```bash
      tmp=$(mktemp ~/.claude/settings.json.XXXXXX) && jq 'del(.outputStyle)' ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json
      ```
      `/output-style` with no argument lists the installed styles and marks
      the active one. Switching with `/output-style <name>` saves the choice
      to `.claude/settings.local.json`, a Local-scope pin of the kind this
      phase warns about, so use the command to inspect, not to fix.

7. **Branch D: no pin but competitors present**: if `PINNED` is empty
   AND competitors exist, print an informational note (no action):
   ```
   outputStyle: no user pin detected. Other plugins also declare
   force-for-plugin: true:
     <list>
   If OMCA Default is not active in your sessions, plugin load order
   may be selecting a competitor first. Disable the competing plugin
   or re-enable OMCA after the competitor.
   ```

---

### Phase 8: Health Report

Print a summary to the user:

Get the current plugin git commit SHA: `cd "${PLUGIN_ROOT}" && git rev-parse --short HEAD 2>/dev/null || echo "unknown"`

```
=== oh-my-claudeagent Setup Complete ===

Dependencies:
  Claude Code: PASS (2.1.287)
  bun:         PASS (1.4.2)
  ast-grep:    WARN (not found - structural code search unavailable)

Files:
  ~/.claude/settings.json  - Inspected only: enabled | local checkout / dev mode | legacy config detected | not configured in user scope
  Plugin root              - ~/.claude/plugins/cache/... | local checkout path
  Git commit            - [short SHA from plugin root]

Platform:
  Restricted session - [Not detected | CLAUDE_CODE_RESTRICTED=1; user, project and local settings ignored, so OMCA hooks and the MCP server are absent]
  Advisor           - [On: <advisorModel> | Off; enable with /advisor fable | Blocked by <variable>]

State:
  .omca/state/  - Verified
  .gitignore   - .omca/ entry present

Restart Claude Code to activate changes.
```

Fill in actual versions from Phase 1 results.

State section:
- `.omca/state/` directory (created when OMCA's server starts): report "Verified" if present, "Will be created on next session start" if not.
- `.omca/` in `.gitignore`: if not present, add it:
  ```bash
  echo '.omca/' >> .gitignore
  ```

---

## UNINSTALL MODE

### Phase 1: Settings and Policy Cleanup Guidance

1. Read `~/.claude/settings.json` if it exists.

2. Report any user-scope references to `oh-my-claudeagent` in:
   - `enabledPlugins`
   - `extraKnownMarketplaces`, or its accepted alias `additionalMarketplaces`
   - legacy `plugins` array entries

3. Print supported cleanup commands instead of editing shared settings automatically:
   ```
   /plugin uninstall oh-my-claudeagent@omca
   /plugin marketplace remove omca
   ```

4. If the plugin is enabled through project or managed settings, explain that those scopes must be cleaned up by editing the appropriate settings file or managed policy deployment. Do not claim this skill can remove enterprise policy on the user's behalf.

---

### Phase 2: Optional Cleanup + Report

1. Ask the user:
   ```
    Remove .omca/ state directory? This deletes plans, evidence, notepads, and any optional local context files stored there. [y/N]
   ```

2. If user confirms, print this command for the user to run in their own shell. Uninstall runs while the plugin is still enabled, and OMCA's guard holds a recursive `rm` from Claude's shell for review:
   ```bash
   rm -rf .omca/
   ```

3. Print uninstall summary:
   ```
   === oh-my-claudeagent Uninstalled ===

Removed:
  ~/.claude/settings.json  - Cleanup guidance printed; manual scope-specific removal may still be needed
  .omca/                    - [Removal command printed | Kept]

   The plugin files remain at their install location or cache copy until Claude Code uninstall/remove commands run.
   ```

---

## CHECK MODE (`--check`)

Non-destructive health check. No files are modified.

1. Run Phase 1 (Dependency Check). Report PASS/WARN/FAIL for each dep.

2. Check `~/.claude/settings.json`:
    - Is the plugin enabled in user settings? Report method (marketplace via enabledPlugins / dev mode via --plugin-dir / legacy plugins array / not registered)
    - Is `CLAUDE_CODE_ENABLE_TODO_TOOLS` set? Report PASS/WARN, and never write it. Claude Code provides `TodoWrite` and the `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` tools by default only on Claude 3.x, Opus 4 through 4.7, Sonnet 4 through 4.6, and Haiku 4.5, and the models the OMCA roster's `opus` and `fable` aliases resolve to are outside that list. Without the variable the task-list mandates in the agent prompts and the `TaskCompleted` gate are both inert
    - Report a WARN for any `ANTHROPIC_DEFAULT_*_MODEL` key, which pins a generation over the tier alias OMCA agents declare
    - Remind the user that managed policy keys such as `strictKnownMarketplaces` (alias `allowedMarketplaces`), `blockedMarketplaces`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`, and `sandbox.failIfUnavailable` are outside this skill's enforcement scope

3. Check `.omca/` state:
   - Do state directories exist?
   - Is `.omca/` in `.gitignore`?

4. Print the Phase 8 health report format with findings (but no "Setup Complete" header; use "Health Check" instead).

---

## DOCTOR MODE (`/oh-my-claudeagent:omca-setup --doctor`)

Extended diagnostic for the OMCA plugin's own configuration. Superset of `--check` with deeper health verification. Read-only: no files are modified, findings are reported for the user to act on.

This is a different tool from the built-in `/doctor` (alias `/checkup`), which checks Claude Code installation health, settings validity, unused extensions, and `CLAUDE.md` size, and can apply fixes after confirming. When the user asks to *fix* their setup, run the built-in `/doctor`. Run this mode only for an OMCA-scoped read-only report, and always name it with its full namespaced invocation so the two are not confused.

### Check 1: Dependencies
Run Phase 1 (Dependency Check). Report PASS/WARN/FAIL for Claude Code, bun, ast-grep.

### Check 2: Permission Namespace Audit
Read `~/.claude/settings.json` and verify the required permission patterns are present:
- `mcp__plugin_oh-my-claudeagent_omca__*`: PASS if present, FAIL if missing
- `mcp__plugin_oh-my-claudeagent_grep__*`: PASS if present
- `mcp__plugin_oh-my-claudeagent_context7__*`: PASS if present
- `Edit(.omca/**)`, `Read(.omca/**)`: PASS if both present
- Check for stale entries. WARN if found ("stale permission; run omca-setup to update"):
  - bare `mcp__grep__*` or `mcp__context7__*`, which match only a server the user configured under that name, never the plugin's own
  - `Write(.omca/**)`: never matched by the file permission checks and makes Claude Code warn at startup. Tell the user to delete it; `Edit(.omca/**)` already covers writing.
  - `env.ANTHROPIC_DEFAULT_OPUS_MODEL`, `env.ANTHROPIC_DEFAULT_SONNET_MODEL`, or `env.ANTHROPIC_DEFAULT_FABLE_MODEL` set to any value: OMCA agents now declare tier aliases (`opus`, `sonnet`, `fable`) and let the platform resolve them. A pin here overrides that resolution for every agent on the tier, so a value naming an older generation (for example `"claude-opus-4-8"`) or carrying a `[1m]` suffix silently holds those agents back. Tell the user to delete the key unless they deliberately want a fixed generation, in which case they own keeping it current.

### Check 3: MCP Server Health
Call `health_check`:
- `runtime` is `ok`: PASS
- `runtime` is `hooks_inactive` or `mod_absent`: FAIL, and report `runtime_reason` verbatim
- The tool is missing: FAIL, OMCA's server is not connected

For the two HTTP servers (`grep`, `context7`), the client already carries the diagnostic. Run:
```bash
claude mcp list
```
`claude mcp list` and `/mcp` report the HTTP status code and the server's error text when a connection fails, so read the reported status rather than guessing:
- Connected: PASS
- `⏸ Pending approval`: WARN, see the approval note below
- `not configured`: the entry has an empty `url`. WARN and point the user at the entry to fill in.
- An HTTP status and error text: FAIL, and report both verbatim. Common causes are an expired or missing auth token (401/403), a wrong URL path (404), and a proxy or network policy blocking the host.
- A missing-variable warning: an `${VAR}` reference in the server config has no value and no `:-default` fallback, so the literal `${VAR}` text was used as the URL.

If a URL looks correct but still fails to connect, check for whitespace: Claude Code warns about MCP config values with hidden leading or trailing whitespace. A trailing space or newline inside the quoted `url` string in `.mcp.json` or `settings.json` makes the value a different host than it reads as.

**Pending approval**: `⏸ Pending approval` applies to project-scoped servers read from a repository's `.mcp.json`. Plugin servers start automatically when the plugin is enabled, so in a marketplace install missing tools point elsewhere: the plugin is disabled, the session is restricted (Check 7), or the server failed at startup. The state reaches the `omca`, `grep`, and `context7` entries only in a session opened inside an OMCA checkout, whose `.mcp.json` then reads as project configuration; approve them once through `/mcp` there.

### Check 4: State Directory Health
- `.omca/state/` exists: PASS/FAIL
- `.omca/` in `.gitignore`: PASS/FAIL

### Check 5: Settings Validation
- `env.ANTHROPIC_DEFAULT_OPUS_MODEL` absent: PASS. Present: WARN ("tier pin overrides the `opus` alias for every opus agent; delete it unless you want a fixed generation")
- `env.CLAUDE_CODE_ENABLE_TODO_TOOLS` set: PASS. Absent: WARN ("Claude Code provides `TodoWrite` and the `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` tools by default only on Claude 3.x, Opus 4 through 4.7, Sonnet 4 through 4.6, and Haiku 4.5, and the models the OMCA roster's `opus` and `fable` aliases resolve to are outside that list, so the task-list mandates in the agent prompts and the `TaskCompleted` gate are both inert"). Report only; this skill never writes the variable
- Plugin enabled in `enabledPlugins`: PASS/FAIL
- Marketplace configured in `extraKnownMarketplaces` or its accepted alias `additionalMarketplaces`: PASS/FAIL. Either spelling counts as configured

### Check 6: Statusline Health
- `~/.claude/statusline/.venv/bin/cc-statusline` exists: PASS/FAIL
- `~/.claude/statusline/servers/tools/_boulder_core.py` exists: PASS/FAIL ("core.py sibling dependency missing; statusline falls back to the `[claude]` stub and subagent statusline crashes; re-run omca-setup to redeploy")
- Render smoke test: pipe a minimal payload through the entry point and confirm the output is not the `[claude]` fallback stub:
  ```bash
  echo '{"model":{"display_name":"X"},"workspace":{"current_dir":"'"$HOME"'"}}' \
    | ~/.claude/statusline/.venv/bin/cc-statusline 2>/dev/null | grep -q '\[claude\]' \
    && echo "WARN: statusline renders fallback stub; sibling deps likely missing" \
    || echo "PASS: statusline renders"
  ```
  PASS/WARN. A `[claude]` result means the package or its `servers/tools` sibling is broken; re-run omca-setup.
- `statusLine` configured in `~/.claude/settings.json`: PASS/WARN
- `statusLine.refreshInterval` present in `~/.claude/settings.json`: PASS/WARN ("refreshInterval missing; statusline won't poll during idle background-agent runs; re-run omca-setup to back-fill")
- If daemon mode: check if daemon is running (`cc-statusline-daemon status`): PASS/WARN

### Check 7: Platform Overrides

Platform settings and environment variables that change how OMCA behaves without touching anything OMCA owns. Every bullet here is report-only: name the condition, name what the user would do, and write nothing.

- `permissions.blockReadsOutsideWorkingDirectories` absent or false: PASS. True: WARN ("the built-in Read, Grep, Glob and LSP tools are fenced to the working directories in every permission mode. The omca `file_read` MCP tool is not fenced, so OMCA still reaches outside the project root. Auto mode offers a one-time `Block from now on` choice that writes this key into user settings from a single keystroke, so confirm you meant to set it; widen with `/add-dir` or delete the key if not")
- `maxEffortLevel` absent or `"max"`: PASS. A `"max"` value sets no cap, at the top level or in a `modelSettings` entry, where it exempts that model from the same file's cap. Any other value: WARN ("a cap below an agent's declared `effort:` wins over frontmatter, so a cap under `high` lowers the planning agents and a cap under `xhigh` lowers oracle. Delete the key or raise it to the highest level the roster declares"). Check the top level and any `modelSettings` entry. Do not warn on `effortLevel`, which was measured not to override frontmatter and leaves the roster alone
- `env.CLAUDE_CODE_EFFORT_LEVEL` absent from `~/.claude/settings.json` and from the project's `.claude/settings.json` and `.claude/settings.local.json`: PASS. Set in any of them: WARN ("this variable outranks every agent's `effort:` frontmatter, so each agent runs at this level instead of the one it declares, still subject to any `maxEffortLevel` cap. Remove it from the settings `env` block unless you want one level everywhere")
- Top-level `effortLevel` in `~/.claude/settings.json`: INFO when present, never WARN ("a top-level `effortLevel` in user settings does not apply to Opus 5.5, Sonnet 5.5, or newer models, so a main session on either starts at that model's default, `medium`, unless you pick a level with `/effort` or the `/model` picker. It still applies on Opus 5, Fable 5.1, and earlier models, and agent `effort:` frontmatter overrides it either way"). A top-level `effortLevel` in project, local, or managed settings applies to every model and needs no note
- `env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE` unset: PASS. Set: WARN ("while this is set the platform ignores every agent definition's `model` field, so the whole roster collapses onto one model and oracle loses its fable tier. Unset it unless you deliberately want one model everywhere"). Plain `CLAUDE_CODE_SUBAGENT_MODEL` needs no warning, since agent frontmatter outranks it
- Advisor. Read `advisorModel` from `~/.claude/settings.json` and the project's `.claude/settings.json` and `.claude/settings.local.json`. Set: PASS, naming the model; for `"sonnet"`, add that an Opus 5.5 main thread rejects a Sonnet advisor, so only the Sonnet workers receive it. Unset everywhere: INFO ("the advisor is off. OMCA's prompts consult it before a large plan, when an error repeats, and before calling a long task done, and fall back to oracle without it. Turn it on with `/advisor fable`, or `/advisor opus` without Fable access. On plans that bill Fable to usage credits, `/advisor fable` saves nothing until you accept that billing once through `/model fable`"). Then check what keeps it off, reading each variable from the live environment (`printenv NAME`) as well as every settings `env` block, since these are often exported from a shell profile: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL` set (the tool is disabled and `advisorModel` ignored); feature-flag fetching turned off by any non-empty `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DO_NOT_TRACK=1`, or `DISABLE_GROWTHBOOK` set to `1` or `true` (the advisor is flag-gated, so it stays off); a third-party provider switch such as `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` (the advisor runs on the Anthropic API only, and these sessions skip flag fetching too). `ANTHROPIC_BASE_URL` set is an INFO in every case: the advisor works only when that gateway forwards the request intact to the Anthropic API, and a Claude apps gateway session has no advisor at all. Each blocker is a WARN when `advisorModel` is set and an INFO when it is not, and names the variable and where it was found. Report only: whether a telemetry opt-out outweighs the advisor is the user's call
- Third-party provider. None of `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` set, in the live environment or a settings `env` block: PASS. One set: INFO naming it ("the `sonnet` tier that explore, executor, and librarian declare resolves to Sonnet 4.6 on Claude Platform on AWS and to Sonnet 4.5 on Bedrock, Google Cloud, and Foundry, well behind the Sonnet 5.5 it means on the Anthropic API. If your provider offers a newer Sonnet, set `ANTHROPIC_DEFAULT_SONNET_MODEL` to its full provider model id"), unless `ANTHROPIC_DEFAULT_SONNET_MODEL` is already set, in which case PASS naming its value
- `env.CLAUDE_CODE_RESTRICTED` unset: PASS. Set to `1`: WARN ("a restricted session ignores user, project, and local settings, so OMCA's hooks and MCP server are absent entirely and every evidence gate, state file, and statusline reading in this report is inert. Start the session without `--restricted` to get the plugin back"). This check reads the environment variable only: a session started with the `--restricted` flag leaves no setting to inspect, so when the variable is absent say that the flag itself is undetectable from inside the session and point at Check 3, where a missing `health_check` tool is the indirect signal

Include all Check 6 findings (including the `refreshInterval` PASS/WARN line) in both the `--doctor` terminal output and the Phase 8 health report. Include the Check 7 `CLAUDE_CODE_RESTRICTED` finding in both places as well: it decides whether the rest of the report describes a live plugin at all. The Check 7 advisor finding also goes in both places, as the Phase 8 `Advisor` line.

Print the Phase 8 health report format with all findings. Use "Doctor Report" header instead of "Health Check". In the step-g user report (Phase 5 step g), add a line under the `~/.claude/settings.json` entry:
```
    ~/.claude/settings.json                   - statusLine added (mode: daemon|direct, refreshInterval: 5)
```

---

## Constraints

- NEVER modify files outside `~/.claude/` and `.omca/` (plus `.gitignore`)
- NEVER claim marketplace installation or managed policy enforcement unless existing Claude Code settings prove it
- Apply settings changes with explicit user confirmation via AskUserQuestion; print jq fallback on decline
- The `allowed-tools` grant covers inspection only: version probes, `jq` reads, `git rev-parse`, `claude mcp list`. It names no `mv`, `cp`, `mkdir`, `rm`, or `uv sync`, so every settings write and every filesystem mutation still goes through the normal permission flow
- Idempotent: setup writes nothing into `CLAUDE.md`, a second run changes nothing already configured, and user content stays unchanged
