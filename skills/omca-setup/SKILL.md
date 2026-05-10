---
name: omca-setup
description: Configure ~/.claude/ for oh-my-claudeagent — injects orchestration block, checks deps, inspects setup state
user-invocable: true
shell: bash
argument-hint: "[--uninstall | --check | --doctor]"
---

# omca-setup — Plugin Configuration

One-command setup: update orchestration block in `~/.claude/CLAUDE.md`, check dependencies, inspect plugin state, print rollout guidance.

**Out of scope**: marketplace install commands, auto-registering in `~/.claude/settings.json`, editing shared/managed settings, enforcing enterprise policy keys (`strictKnownMarketplaces`, `blockedMarketplaces`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`).

**Policy baseline**: Claude Code native settings authoritative. `teammateMode: "auto"` is normal. Managed settings are non-overridable policy. `permission-filter.sh` is guardrail-only — does not auto-allow.

**Install/update flow**:

- Install: `/plugin marketplace add UtsavBalar1231/oh-my-claudeagent` then `/plugin install oh-my-claudeagent@omca`
- Update: `/plugin marketplace update omca` then `/plugin install oh-my-claudeagent@omca`
- Apply in-session: `/reload-plugins`

**`--bare` caveat**: `claude --bare` skips plugin, hooks, skills, MCP, and CLAUDE.md auto-discovery. Run setup in normal (non-`--bare`) sessions.

**Plugin options**:

- `enableKeywordTriggers`: bool, default `false`
- `statuslineMode`: `off|direct|daemon`, default `direct`
- `disableForceOrchestrationStyle`: bool, default `false` — strips `force-for-plugin: true` from the installed style cache copy so your own `outputStyle` takes precedence; re-run setup after each plugin update

**Sandbox**: For fail-closed environments, use `sandbox.failIfUnavailable: true` in managed settings. This skill reports sandbox posture but does not bypass host enforcement.

**Output style**: `output-styles/omca-default.md` (manifest `"outputStyles": "./output-styles/"`).

---

## Mode Detection

Parse `$ARGUMENTS` for flags:
- `--uninstall` → jump to UNINSTALL MODE
- `--check` → jump to CHECK MODE
- `--doctor` → jump to DOCTOR MODE
- No flag → SETUP MODE (default)

---

## SETUP MODE

### Phase 1: Dependency Check

Run these checks in parallel:

```bash
command -v jq && jq --version
```
→ PASS/FAIL. If jq is missing, **STOP** — hooks will not work without it.

```bash
command -v uv && uv --version
```
→ PASS/FAIL. If uv is missing, **STOP** — MCP servers will not start without it.

```bash
command -v python3 && python3 --version
```
→ PASS/WARN (needed for ast-grep MCP server; uv manages the Python environment)

```bash
if command -v ast-grep >/dev/null 2>&1; then ast-grep --version 2>&1 | head -1; else command -v sg >/dev/null 2>&1 && sg --version 2>&1 | head -1; fi
```
→ PASS/WARN (optional — needed for structural code search MCP tools; accepts either `ast-grep` or `sg`)

Record each result (binary path + version or "not found") for the health report.

---

### Phase 2: Read Plugin Version

1. Determine the plugin root. Navigate from this skill's location:
   - This SKILL.md is at `skills/omca-setup/SKILL.md`
   - Plugin root = two directories up from this file
   - Use `Bash: dirname` of the skill path or use `CLAUDE_PLUGIN_ROOT` env var

2. Read the plugin version:
   ```
   Read("${PLUGIN_ROOT}/.claude-plugin/plugin.json")
   ```
   Extract the `version` field with jq.

---

### Phase 3: Backup and Read Existing

**If `~/.claude/CLAUDE.md` exists:**

1. Create a backup:
   ```bash
   cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak
   ```

2. Read the existing file:
   ```
   Read("~/.claude/CLAUDE.md")
   ```

3. **Migration check (old developer's format):**
   - Detect `<!-- OMCA:START -->` OR `<\!-- OMCA:START -->` (with or without backslash escape)
   - If found: remove everything from the old start marker line through the old end marker line (`<!-- OMCA:END -->` or `<\!-- OMCA:END -->`)
   - Log to user: "Migrated: removed old OMC block from other developer"

4. **Own block check (migration):**
   - Detect line matching `^--- omca-setup\s*$`
   - If found: remove the entire block from `^--- omca-setup\s*$` through `^--- /omca-setup ---\s*$` (inclusive) — this block was written by old injection-mode installs; the orchestration body is now delivered via `output-styles/omca-default.md`
   - If NOT found: no block to remove

5. Everything remaining after removing detected blocks = **user content** (preserve exactly)

**If `~/.claude/CLAUDE.md` does NOT exist:**

1. Create the directory:
   ```bash
   mkdir -p ~/.claude
   ```

2. User content = empty string

---

### Phase 4: Write CLAUDE.md

The orchestration body is now delivered by `output-styles/omca-default.md` via the
platform's output-style mechanism — it no longer needs to live in `~/.claude/CLAUDE.md`.

Compose the final file:
- **User content** (from Phase 3, if any)

If user content is empty (the entire old file was just an omca-setup block now removed),
write an empty file or skip the write entirely.

If user content is non-empty, write it to `~/.claude/CLAUDE.md`.

---

### Phase 5: Registration Inspection and Rollout Guidance

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
   - `strictKnownMarketplaces` → allow only admin-approved marketplaces
   - `blockedMarketplaces` → explicitly deny marketplaces that should never resolve
   - `allowManagedHooksOnly` → allow only hooks defined in managed settings
   - `allowManagedPermissionRulesOnly` → allow only managed permission rules
   - `allowManagedMcpServersOnly` → allow only managed MCP server definitions
   - `sandbox.failIfUnavailable` → fail closed if the sandbox cannot be applied

   These keys belong in managed settings when the organization needs non-overridable policy — this skill only points the user/admin at them. Marketplace-installed copies run from `~/.claude/plugins/cache/...`; the local `omca` MCP server bootstraps its ast-grep Python environment inside the active plugin root or cache copy, not in shared global state.

---

### Phase 5.5: Settings Configuration

Apply optional user-scope helper settings to `~/.claude/settings.json` with user confirmation.

1. Read `~/.claude/settings.json` (if exists; if not, start with `{}`)

2. Detect managed-policy lock keys in current scope (`allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`). If present and true, do not propose local permission-rule writes; report that managed policy owns permission enforcement.

3. Compute missing optional helper permissions against the recommended set:
   - `Write(.omca/**)`, `Edit(.omca/**)`, `Read(.omca/**)`
   - `mcp__plugin_oh-my-claudeagent_omca__*`, `mcp__grep__*`, `mcp__context7__*`
   - `Bash(jq *)`, `Bash(uv run *)`, `Bash(uv sync *)`

4. Compute missing top-level: `teammateMode: "auto"`

5. Compute missing env vars against the required set:
   - `ANTHROPIC_DEFAULT_OPUS_MODEL`: `"claude-opus-4-7[1m]"` — routes opus-tier agents to extended-thinking model
   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`: `"1"` — enables agent teams (required for `teammateMode: "auto"`)

6. If all present: "Settings already configured" — skip

7. If changes needed: show diff, use `AskUserQuestion` to confirm

8. On confirm: read-merge-write with `jq` (handle nonexistent file)

9. On decline: print raw jq command as fallback:
   ```
   jq '. + {
     "teammateMode": "auto"
   } | .env += {
     "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-7[1m]",
     "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
   } | .permissions.allow += [
     "Write(.omca/**)",
     "Edit(.omca/**)",
     "Read(.omca/**)",
     "mcp__plugin_oh-my-claudeagent_omca__*",
     "mcp__grep__*",
     "mcp__context7__*",
     "Bash(jq *)",
     "Bash(uv run *)",
     "Bash(uv sync *)"
   ]' ~/.claude/settings.json > /tmp/claude-settings-tmp.json && mv /tmp/claude-settings-tmp.json ~/.claude/settings.json
   ```

10. Explain each setting:
   - `teammateMode: "auto"` — enables agent teams with best available UI (tmux/iTerm2 split panes)
   - `ANTHROPIC_DEFAULT_OPUS_MODEL` — routes opus-tier agents (oracle, prometheus, metis, momus, sisyphus) to `claude-opus-4-7[1m]` for extended thinking
   - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — enables the experimental agent teams feature, required for `teammateMode: "auto"` to function
    - `Write(.omca/**)` / `Edit(.omca/**)` / `Read(.omca/**)` — auto-allow plugin state file access
    - `mcp__plugin_oh-my-claudeagent_omca__*` / `mcp__grep__*` / `mcp__context7__*` — auto-allow bundled MCP tool usage
    - `Bash(jq *)` / `Bash(uv run *)` / `Bash(uv sync *)` — auto-allow common plugin utility commands (narrowed from `Bash(uv *)`)
    - These are optional local helper allowances; managed settings remain the policy authority.

---

### Phase 5.6: Statusline Setup

Configure the Claude Code statusline to use the oh-my-claudeagent statusline package.

1. Read `~/.claude/settings.json` (if it exists; otherwise treat as `{}`).

2. Check if `statusLine` is already configured:
   - If `settings.statusLine` is present → print "statusLine already configured — skipping" and skip this phase.

3. If not configured: use `AskUserQuestion` to ask:
   ```
   Enable the oh-my-claudeagent statusline? It shows model, context bar, cost, duration, git status, and more in your terminal.
   [y/N]
   ```

4. On decline: skip this phase silently.

5. On confirm:

   a. **Resolve the plugin root** (Python):
      ```python
      import glob, os
      candidates = glob.glob(os.path.expanduser("~/.claude/plugins/cache/omca/oh-my-claudeagent/*/"))
      plugin_root = sorted(candidates)[-1] if candidates else None
      ```
      If no candidates found (development mode), fall back to the git root:
      ```python
      import subprocess
      result = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
      plugin_root = result.stdout.strip() if result.returncode == 0 else None
      ```
      If `plugin_root` is still `None`, report an error and skip the phase.

   b. **Create the deployment structure** at `~/.claude/statusline/`:

      Layout:
      ```
      ~/.claude/statusline/
        pyproject.toml              ← copied from <plugin-root>/statusline/pyproject.toml
        statusline/                 ← copied from <plugin-root>/statusline/*.py
          __init__.py
          core.py
          git.py
          daemon.py
          client.py
          direct.py
      ```

      Commands (replace `<plugin-root>` with the path from step a):
      ```bash
      mkdir -p ~/.claude/statusline/statusline
      cp <plugin-root>/statusline/pyproject.toml ~/.claude/statusline/pyproject.toml
      cp <plugin-root>/statusline/*.py ~/.claude/statusline/statusline/
      ```

   c. **Run `uv sync`** to create the venv and install entry points:
      ```bash
      uv sync --project ~/.claude/statusline
      ```

   d. **Ask user for mode selection** using `AskUserQuestion`:
      ```
      Statusline mode?
        1. Daemon (fastest, <1ms warm response) [recommended]
        2. Direct (simpler, ~20ms response)
      ```
      Default to daemon (option 1) if the user picks 1 or confirms without a specific choice.

   e. **Set the settings.json command** based on mode:
      - Daemon: `~/.claude/statusline/.venv/bin/cc-statusline`
      - Direct: `~/.claude/statusline/.venv/bin/cc-statusline-direct`

      Use jq to merge atomically (read-merge-write):
      ```bash
      jq --arg cmd "<chosen-command>" '. + {"statusLine": {"type": "command", "command": $cmd, "padding": 1}}' \
        ~/.claude/settings.json > /tmp/claude-settings-statusline.json \
        && mv /tmp/claude-settings-statusline.json ~/.claude/settings.json
      ```
      If `~/.claude/settings.json` does not exist, create it from `{}`:
      ```bash
      echo '{}' | jq --arg cmd "<chosen-command>" '. + {"statusLine": {"type": "command", "command": $cmd, "padding": 1}}' \
        > ~/.claude/settings.json
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
        ~/.claude/statusline/pyproject.toml       — package manifest
        ~/.claude/statusline/statusline/          — package files (copied from plugin)
        ~/.claude/statusline/.venv/               — uv-managed venv with entry points
        ~/.claude/settings.json                   — statusLine added (mode: daemon|direct)

      For daemon mode: daemon started (auto-starts on first request if not running)
      Restart Claude Code to activate the statusline.

      Note: After plugin updates, re-copy the files and re-run uv sync to pick up changes:
        cp <plugin-root>/statusline/pyproject.toml ~/.claude/statusline/pyproject.toml
        cp <plugin-root>/statusline/*.py ~/.claude/statusline/statusline/
        uv sync --project ~/.claude/statusline
      Or simply re-run /oh-my-claudeagent:omca-setup (it will skip already-configured phases).
      ```

   h. **Note**: If an old `~/.claude/statusline.py` wrapper script exists, it can be removed — it is superseded by this copy-based deployment.

---

### Phase 5.7: Force-Style Opt-Out

Apply or skip the `disableForceOrchestrationStyle` opt-out based on the user's plugin config.

1. Read the env var:
   ```bash
   OPT_OUT="${CLAUDE_PLUGIN_OPTION_DISABLEFORCEORCHESTRATIONSTYLE:-}"
   ```

2. Read the plugin version from `${PLUGIN_ROOT}/.claude-plugin/plugin.json`:
   ```bash
   PLUGIN_VERSION=$(jq -r '.version' "${PLUGIN_ROOT}/.claude-plugin/plugin.json")
   ```

3. Locate the installed cache copy of the style file:
   ```bash
   STYLE_FILE="${HOME}/.claude/plugins/cache/oh-my-claudeagent/${PLUGIN_VERSION}/output-styles/omca-default.md"
   ```
   If the file does not exist (development-mode install, or the cache path differs), skip this phase and note to user: "output-styles/omca-default.md not found in plugin cache — skipping force-style opt-out (development mode or non-standard install path)."

4. Locate the sidecar state file:
   ```bash
   SIDECAR="${HOME}/.claude/plugins/cache/oh-my-claudeagent/.omca-force-strip-state.json"
   ```

5. **If `OPT_OUT` is `true` or `1`**:

   a. Read the style file mtime:
      ```bash
      FILE_MTIME=$(python3 -c "import os; print(int(os.path.getmtime('${STYLE_FILE}')))")
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

   c. **Already applied and file unchanged** — if `APPLIED_MTIME == FILE_MTIME` and `APPLIED_VER == PLUGIN_VERSION`, print "force-style strip already applied — no-op." and skip to step 6.

   d. **Apply the strip** — remove the `force-for-plugin: true` line (portable Python one-liner avoids GNU/BSD sed differences):
      ```bash
      python3 -c "
      import re, sys
      path = sys.argv[1]
      text = open(path).read()
      stripped = re.sub(r'^force-for-plugin: true\n', '', text, flags=re.MULTILINE)
      open(path, 'w').write(stripped)
      " "${STYLE_FILE}"
      ```
      Idempotent: if the line is already absent, the substitution is a no-op.

   e. **Update the sidecar** (atomic write):
      ```bash
      NEW_MTIME=$(python3 -c "import os; print(int(os.path.getmtime('${STYLE_FILE}')))")
      python3 -c "
      import json, sys
      data = {'applied_at_mtime': int(sys.argv[1]), 'version': sys.argv[2]}
      open(sys.argv[3], 'w').write(json.dumps(data) + '\n')
      " "${NEW_MTIME}" "${PLUGIN_VERSION}" "${SIDECAR}"
      ```

   f. Report to user:
      ```
      force-for-plugin: true stripped from output-styles/omca-default.md (cache copy v${PLUGIN_VERSION}).
      Your own outputStyle setting will take precedence.
      Sidecar: ~/.claude/plugins/cache/oh-my-claudeagent/.omca-force-strip-state.json
      Note: re-run /oh-my-claudeagent:omca-setup after each plugin update to re-apply the strip.
      ```

6. **If `OPT_OUT` is unset, `false`, or `0`**: skip silently — no changes to the style file.

---

### Phase 6: Health Report

Print a summary to the user:

Get the current plugin git commit SHA: `cd "${PLUGIN_ROOT}" && git rev-parse --short HEAD 2>/dev/null || echo "unknown"`

```
=== oh-my-claudeagent Setup Complete ===

Dependencies:
  jq:      PASS (v1.7.1)
  python3: PASS (v3.12.0)
  ast-grep: WARN (not found — structural code search unavailable)

Files:
  ~/.claude/CLAUDE.md      — Block injected v0.1.0 (backup: CLAUDE.md.bak)
  ~/.claude/settings.json  — Inspected only: enabled | local checkout / dev mode | legacy config detected | not configured in user scope
  Plugin root              — ~/.claude/plugins/cache/... | local checkout path
  Git commit            — [short SHA from plugin root]

State:
  .omca/state/  — Verified
  .omca/logs/   — Verified
  Plugin-local .venv    — [Present | Auto-created on first ast-grep MCP server start in the active plugin root]
  .gitignore   — .omca/ entry present

Restart Claude Code to activate changes.
```

Fill in actual versions from Phase 1 results.

State section:
- `.omca/state/` and `.omca/logs/` directories (auto-created on session start) — report "Verified" if present, "Will be created on next session start" if not
- `.omca/` in `.gitignore` — if not, add it:
  ```bash
  echo '.omca/' >> .gitignore
  ```

---

## UNINSTALL MODE

### Phase 1: Remove Block from CLAUDE.md

1. Read `~/.claude/CLAUDE.md`

2. Detect and remove own block:
   - Find line matching `^--- omca-setup\s*$` through `^--- /omca-setup ---\s*$` → remove entirely

3. Also detect and remove old format:
   - Find `<!-- OMCA:START -->` or `<\!-- OMCA:START -->` through corresponding end marker → remove entirely

4. If the file is now empty or whitespace-only → delete it:
   ```bash
   rm ~/.claude/CLAUDE.md
   ```
   Otherwise write back the remaining content.

---

### Phase 2: Settings and Policy Cleanup Guidance

1. Read `~/.claude/settings.json` if it exists.

2. Report any user-scope references to `oh-my-claudeagent` in:
   - `enabledPlugins`
   - `extraKnownMarketplaces`
   - legacy `plugins` array entries

3. Print supported cleanup commands instead of editing shared settings automatically:
   ```
   /plugin uninstall oh-my-claudeagent@omca
   /plugin marketplace remove omca
   ```

4. If the plugin is enabled through project or managed settings, explain that those scopes must be cleaned up by editing the appropriate settings file or managed policy deployment. Do not claim this skill can remove enterprise policy on the user's behalf.

---

### Phase 3: Optional Cleanup + Report

1. Ask the user:
   ```
    Remove .omca/ state directory? This deletes logs, plans, and any optional local context files stored there. [y/N]
   ```

2. If user confirms:
   ```bash
   rm -rf .omca/
   ```

3. Print uninstall summary:
   ```
   === oh-my-claudeagent Uninstalled ===

Removed:
  ~/.claude/CLAUDE.md      — Block removed (or file deleted)
  ~/.claude/settings.json  — Cleanup guidance printed; manual scope-specific removal may still be needed
  .omca/                    — [Removed | Kept]

   The plugin files remain at their install location or cache copy until Claude Code uninstall/remove commands run.
   ```

---

## CHECK MODE (`--check`)

Non-destructive health check — no files are modified.

1. Run Phase 1 (Dependency Check) — report PASS/WARN/FAIL for each dep

2. Check `~/.claude/CLAUDE.md`:
   - Does own block exist? Report version if found
   - Does old format block exist? Report "migration needed"
   - No block found? Report "not configured — run omca-setup"

3. Check `~/.claude/settings.json`:
    - Is the plugin enabled in user settings? Report method (marketplace via enabledPlugins / dev mode via --plugin-dir / legacy plugins array / not registered)
    - Are required env vars configured (`ANTHROPIC_DEFAULT_OPUS_MODEL`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`)? Report each as PASS/WARN
    - Remind the user that managed policy keys such as `strictKnownMarketplaces`, `blockedMarketplaces`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`, and `sandbox.failIfUnavailable` are outside this skill's enforcement scope

4. Check `.omca/` state:
   - Do state directories exist?
   - Is `.omca/` in `.gitignore`?

5. Print the Phase 6 health report format with findings (but no "Setup Complete" header — use "Health Check" instead)

---

## DOCTOR MODE (`--doctor`)

Extended diagnostic — superset of `--check` with deeper health verification. No files are modified.

### Check 1: Dependencies
Run Phase 1 (Dependency Check) — report PASS/WARN/FAIL for jq, uv, python3, ast-grep.

### Check 2: CLAUDE.md Block
- Does own block exist in `~/.claude/CLAUDE.md`? Report version if found.
- Does old format block exist? Report "migration needed".
- No block? Report "not configured — run omca-setup".

### Check 3: Permission Namespace Audit
Read `~/.claude/settings.json` and verify the required permission patterns are present:
- `mcp__plugin_oh-my-claudeagent_omca__*` — PASS if present, FAIL if missing or has old bare `mcp__omca-state__*` or `mcp__ast-grep__*`
- `mcp__grep__*` — PASS if present (HTTP server, bare name is correct)
- `mcp__context7__*` — PASS if present (HTTP server, bare name is correct)
- `Write(.omca/**)`, `Edit(.omca/**)`, `Read(.omca/**)` — PASS if all present
- `Bash(jq *)`, `Bash(uv run *)`, `Bash(uv sync *)` — PASS if all present
- Check for stale entries: `mcp__pgs__*`, `mcp__omca-state__*`, `mcp__ast-grep__*` — WARN if found ("stale permission — run omca-setup to update")

### Check 4: MCP Server Health
For each command-type MCP server, verify it can start and respond:
```bash
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | timeout 5 uv run --project ${PLUGIN_ROOT}/servers omca-mcp.py 2>/dev/null
```
- PASS if response contains `"result"` with tool definitions
- FAIL if timeout, error, or no response
- Note: HTTP servers (grep.app, context7) are external — skip or ping-only

### Check 5: State Directory Health
- `.omca/state/` exists — PASS/FAIL
- `.omca/logs/` exists — PASS/FAIL
- `.omca/` in `.gitignore` — PASS/FAIL

### Check 6: Settings Validation
- `teammateMode` is `"auto"` — PASS/WARN
- `env.ANTHROPIC_DEFAULT_OPUS_MODEL` is `"claude-opus-4-7[1m]"` — PASS/WARN ("opus agents may use non-extended model")
- `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is `"1"` — PASS/WARN ("agent teams disabled — teammateMode won't function")
- Plugin enabled in `enabledPlugins` — PASS/FAIL
- Marketplace configured in `extraKnownMarketplaces` — PASS/FAIL

### Check 7: Statusline Health
- `~/.claude/statusline/.venv/bin/cc-statusline` exists — PASS/FAIL
- `statusLine` configured in `~/.claude/settings.json` — PASS/WARN
- If daemon mode: check if daemon is running (`cc-statusline-daemon status`) — PASS/WARN

Print the Phase 6 health report format with all findings. Use "Doctor Report" header instead of "Health Check".

---

## Constraints

- ALWAYS backup `~/.claude/CLAUDE.md` before any write (Phase 3)
- NEVER modify files outside `~/.claude/` and `.omca/` (plus `.gitignore`)
- NEVER claim marketplace installation or managed policy enforcement unless existing Claude Code settings prove it
- Apply settings changes with explicit user confirmation via AskUserQuestion; print jq fallback on decline
- Idempotent: running setup multiple times with the same version is a no-op
- Migration handles both `<!-- OMCA:START -->` and `<\!-- OMCA:START -->` (escaped and unescaped)
