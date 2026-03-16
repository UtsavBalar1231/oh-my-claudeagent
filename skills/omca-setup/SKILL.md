---
name: omca-setup
description: Configure ~/.claude/ for oh-my-claudeagent — injects orchestration block, checks deps, inspects setup state
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
user-invocable: true
argument-hint: "[--uninstall | --check]"
---

# omca-setup — Plugin Configuration

One-command setup for oh-my-claudeagent. Updates the orchestration block in `~/.claude/CLAUDE.md`,
checks dependencies, inspects current plugin registration state, and prints rollout guidance.

This skill does not run marketplace install commands on the user's behalf, does not auto-edit shared or managed Claude Code settings, and does not claim to enforce enterprise policy keys such as `strictKnownMarketplaces`, `blockedMarketplaces`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, or `allowManagedMcpServersOnly`.

---

## Mode Detection

Parse `$ARGUMENTS` for flags:
- `--uninstall` → jump to UNINSTALL MODE
- `--check` → jump to CHECK MODE
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

### Phase 2: Read Template

1. Determine the plugin root. Navigate from this skill's location:
   - This SKILL.md is at `skills/omca-setup/SKILL.md`
   - Plugin root = two directories up from this file
   - Use `Bash: dirname` of the skill path or use `CLAUDE_PLUGIN_ROOT` env var

2. Read the template file:
   ```
   Read("${PLUGIN_ROOT}/templates/claudemd.md")
   ```

3. Read the plugin version:
   ```
   Read("${PLUGIN_ROOT}/.claude-plugin/plugin.json")
   ```
   Extract the `version` field with jq.

4. Update the template content in memory:
   - Replace `version: 0.1.0` (or whatever is in the template) with `version: ${CURRENT_VERSION}` from plugin.json
   - Add `installed: ${ISO_8601_TIMESTAMP}` line after the `author:` line in metadata
   - Get the current timestamp: `Bash: date -u +%Y-%m-%dT%H:%M:%SZ`

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

4. **Own block check:**
   - Detect line matching `^--- omca-setup\s*$`
   - If found: extract `version:` value from the metadata section (lines between `--- omca-setup` and next `---`)
     - **Same version as plugin.json** → print "Already at version X.Y.Z — no changes needed." and jump directly to Phase 6 (health report only).
     - **Different version** → remove the entire block from `^--- omca-setup\s*$` through `^--- /omca-setup ---\s*$` (inclusive)
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

Compose the final file:
- **Template block** (from Phase 2, with updated version and installed timestamp)
- **Blank line** (separator)
- **User content** (from Phase 3, if any)

If user content is empty (the entire old file was just a block), write only the template block.

Write the composed content to `~/.claude/CLAUDE.md`.

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

4. Print enterprise rollout guidance (inspection only; do not write or enforce it):
   - `strictKnownMarketplaces` → allow only marketplaces your admins approve
   - `blockedMarketplaces` → explicitly deny marketplaces that should never resolve
   - `allowManagedHooksOnly` → allow only hooks defined in managed settings
   - `allowManagedPermissionRulesOnly` → allow only managed permission rules
   - `allowManagedMcpServersOnly` → allow only managed MCP server definitions

   Explain that these keys belong in managed settings when the organization needs non-overridable policy, and that this skill can only point the user/admin at them.

---

### Phase 5.5: Settings Suggestions

Inspect `~/.claude/settings.json` and suggest beneficial settings additions. Print commands — do NOT auto-edit.

1. Read `~/.claude/settings.json` (if it exists) to check current settings.

2. **Suggested settings** (print as a copyable `jq` merge command):

   ```
   Recommended settings for optimal oh-my-claudeagent experience:

   jq '. + {
     "teammateMode": "auto"
   } | .permissions.allow += [
     "Edit(.omca/**)",
     "Read(.omca/**)",
     "mcp__omca-state__*",
     "mcp__ast-grep__*",
     "mcp__grep__*",
     "Bash(jq *)",
     "Bash(uv *)"
   ]' ~/.claude/settings.json > /tmp/claude-settings-tmp.json && mv /tmp/claude-settings-tmp.json ~/.claude/settings.json
   ```

3. Explain each setting:
   - `teammateMode: "auto"` — enables agent teams with best available UI (tmux/iTerm2 split panes)
   - `Edit(.omca/**)` / `Read(.omca/**)` — auto-allow plugin state file access
   - `mcp__omca-state__*` / `mcp__ast-grep__*` / `mcp__grep__*` — auto-allow bundled MCP tool usage
   - `Bash(jq *)` / `Bash(uv *)` — auto-allow common plugin utility commands

4. Note: "These settings are suggestions only. Review and apply as needed. If `~/.claude/settings.json` doesn't exist, create it first with `echo '{}' > ~/.claude/settings.json`."

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

For the State section:
- Check if `.omca/state/` and `.omca/logs/` directories exist (they are created by `session-init.sh`) — report "Verified" if present, "Will be created on next session start" if not
- Check if `.omca/` is in `.gitignore` — if not, add it:
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
    - Remind the user that managed policy keys such as `strictKnownMarketplaces`, `blockedMarketplaces`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, and `allowManagedMcpServersOnly` are outside this skill's enforcement scope

4. Check `.omca/` state:
   - Do state directories exist?
   - Is `.omca/` in `.gitignore`?

5. Print the Phase 6 health report format with findings (but no "Setup Complete" header — use "Health Check" instead)

---

## Constraints

- ALWAYS backup `~/.claude/CLAUDE.md` before any write (Phase 3)
- NEVER modify files outside `~/.claude/` and `.omca/` (plus `.gitignore`)
- NEVER claim marketplace installation or managed policy enforcement unless existing Claude Code settings prove it
- NEVER auto-edit shared or managed Claude Code settings during setup; print guidance instead
- Idempotent: running setup multiple times with the same version is a no-op
- Template is read from disk, not generated — ensures deterministic output
- Migration handles both `<!-- OMCA:START -->` and `<\!-- OMCA:START -->` (escaped and unescaped)
