---
name: omca-setup
description: Configure ~/.claude/ for oh-my-claudeagent — injects orchestration block, checks deps, verifies marketplace registration
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
user-invocable: true
disable-model-invocation: true
argument-hint: "[--uninstall | --check]"
---

# omca-setup — Plugin Configuration

One-command setup for oh-my-claudeagent. Injects the orchestration block into `~/.claude/CLAUDE.md`,
checks dependencies, and registers the plugin in `~/.claude/settings.json`.

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
command -v python3 && python3 --version
```
→ PASS/WARN (needed for ast-grep MCP server; venv auto-bootstraps on first use)

```bash
command -v ast-grep && ast-grep --version 2>&1 | head -1
```
→ PASS/WARN (optional — needed for structural code search MCP tools)

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

### Phase 5: Plugin Registration

1. Read `~/.claude/settings.json` (if it doesn't exist, start with `{}`)

2. **Auto-detect install method:**
   - Check if `enabledPlugins` object has any key starting with `oh-my-claudeagent` → already registered via marketplace, **skip**
   - Check if the current session was loaded via `--plugin-dir` (e.g., `CLAUDE_PLUGIN_ROOT` is not under `~/.claude/plugins/cache/`) → development mode, **skip** with note: "Running via --plugin-dir (development mode) — no persistent registration needed."
   - If neither found → print instructions:
     ```
     Plugin not registered. Run these commands to install via marketplace:

       /plugin marketplace add UtsavBalar1231/oh-my-claudeagent
       /plugin install oh-my-claudeagent@omca
     ```
   - If a `plugins` array entry containing `oh-my-claudeagent` is found → legacy git clone install detected. Print:
     ```
     Legacy git-clone installation detected in plugins array.
     To migrate to marketplace, remove the plugins array entry and run:

       /plugin marketplace add UtsavBalar1231/oh-my-claudeagent
       /plugin install oh-my-claudeagent@omca
     ```

---

### Phase 6: Health Report

Print a summary to the user:

```
=== oh-my-claudeagent Setup Complete ===

Dependencies:
  jq:      PASS (v1.7.1)
  python3: PASS (v3.12.0)
  ast-grep: WARN (not found — structural code search unavailable)

Files:
  ~/.claude/CLAUDE.md      — Block injected v0.1.0 (backup: CLAUDE.md.bak)
  ~/.claude/settings.json  — Marketplace: registered | Dev mode: --plugin-dir | Not registered (see above)

State:
  .omca/state/  — Verified
  .omca/logs/   — Verified
  .venv/               — [Present | Auto-created on first MCP server start]
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

### Phase 2: Deregister from settings.json

1. Read `~/.claude/settings.json`

2. Remove any key starting with `oh-my-claudeagent` from `enabledPlugins` object

3. Remove any legacy path containing `oh-my-claudeagent` from `plugins` array (if present, from old git clone installs)

4. Write back the modified JSON (preserve all other settings)

5. Print note: "To fully remove the marketplace source, run: `/plugin marketplace remove omca`"

---

### Phase 3: Optional Cleanup + Report

1. Ask the user:
   ```
   Remove .omca/ state directory? This deletes logs, plans, and project memory. [y/N]
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
     ~/.claude/settings.json  — Plugin deregistered
     .omca/                    — [Removed | Kept]

   The plugin files remain at their install location.
   To fully remove, delete the plugin directory.
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
   - Is the plugin registered? Report method (marketplace via enabledPlugins / dev mode via --plugin-dir / legacy plugins array / not registered)

4. Check `.omca/` state:
   - Do state directories exist?
   - Is `.omca/` in `.gitignore`?

5. Print the Phase 6 health report format with findings (but no "Setup Complete" header — use "Health Check" instead)

---

## Constraints

- ALWAYS backup `~/.claude/CLAUDE.md` before any write (Phase 3)
- NEVER modify files outside `~/.claude/` and `.omca/` (plus `.gitignore`)
- Idempotent: running setup multiple times with the same version is a no-op
- Template is read from disk, not generated — ensures deterministic output
- Migration handles both `<!-- OMCA:START -->` and `<\!-- OMCA:START -->` (escaped and unescaped)
