---
name: init-deep
description: Generate hierarchical AGENTS.md files for a codebase (root + scored subdirectories).
when_to_use: |
  Use when:
  - Starting work on a new or unfamiliar codebase
  - AGENTS.md files are missing or stale
  - User says "init deep", "generate AGENTS.md", or "document project structure"
  - After a large refactor that changed directory layout
user-invocable: true
argument-hint: "[project path]"
effort: medium
---

# /init-deep

Generate hierarchical AGENTS.md files. Root + complexity-scored subdirectories.

## Usage

```
/init-deep                      # Update mode: modify existing + create new where warranted
/init-deep --create-new         # Read existing → remove all → regenerate from scratch
/init-deep --max-depth=2        # Limit directory depth (default: 3)
```

## Workflow

1. **Discovery + Analysis** (concurrent): explore agents, bash structure, codemap, existing AGENTS.md
2. **Score & Decide**: AGENTS.md locations from merged findings
3. **Generate**: root first, subdirs in parallel
4. **Review**: deduplicate, trim, validate

## Phase 1: Discovery + Analysis (Concurrent)

### Background Explore Agents

Each explore agent re-reads the repository from scratch and hands back a report you then read, so delegate only the tracks the Bash pass below cannot answer in a few reads: none for a small repository, and at most five in total for a large one. Launch the ones you choose in a single message so they run concurrently, and brief each with its directory scope and what to report. Candidate tracks:

- Entry points and non-standard organization
- Config files (.eslintrc, pyproject.toml, .editorconfig) and the project-specific rules they encode
- Comments that mark forbidden or deprecated patterns (`DO NOT`, `NEVER`, `DEPRECATED`), with the reason each gives
- Build and CI (.github/workflows, Makefile) where it departs from the defaults
- Test configuration and layout

### Background Agent Barrier

Merge the explore findings only after every agent has reported. Until then, carry on with the main-session analysis below, which does not overlap theirs; when it is done and agents are still running, end the turn once instead of answering each notification with a holding message.

### Main Session (concurrent with agents)

#### 1. Bash Structural Analysis
```bash
find . -type d -not -path '*/\.*' -not -path '*/node_modules/*' -not -path '*/venv/*' -not -path '*/dist/*' -not -path '*/build/*' | awk -F/ '{print NF-1}' | sort -n | uniq -c
find . -type f -not -path '*/\.*' -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30
find . -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20
find . -type f \( -name "AGENTS.md" -o -name "CLAUDE.md" \) -not -path '*/node_modules/*' 2>/dev/null
```

#### 2. Read Existing AGENTS.md

Extract key insights, conventions, anti-patterns. `--create-new`: read first (preserve context) → delete → regenerate.

#### 3. LSP Codemap (if available)

If the `LSP` tool is active (it needs a code-intelligence plugin for the language), use it to list the symbols in entry-point files, search symbols across the workspace, and find references into heavily used modules. Otherwise rely on the explore agents and the Bash pass.

## Phase 2: Scoring & Location Decision

The root always gets an AGENTS.md. A subdirectory gets one when an agent working inside it would need knowledge that neither the root file nor the code in front of it supplies. Signals, strongest first:

- Its own config, build, or test commands
- A module boundary that other code imports through (`index.ts`, `__init__.py`, a public API)
- Conventions or constraints that differ from its parent
- Code much of the repository depends on (many incoming references, when the `LSP` tool is active)
- Size: many files or subdirectories make the other signals likelier without being one

Leave a directory to its parent file when the parent already covers it. Every extra file costs context in each session that loads it.

## Phase 3: Generate AGENTS.md

### Root AGENTS.md

```markdown
# PROJECT KNOWLEDGE BASE

**Generated:** {TIMESTAMP}
**Commit:** {SHORT_SHA}

## OVERVIEW
{1-2 sentences: what + core stack}

## STRUCTURE
{Tree with non-obvious purposes only}

## WHERE TO LOOK
| Task | Location | Notes |

## CONVENTIONS
{ONLY deviations from standard}

## ANTI-PATTERNS (THIS PROJECT)
{Explicitly forbidden here}

## COMMANDS
{dev/test/build}
```

Quality bar: every line tells an agent something it could not infer from the code or from general knowledge of the stack. Later sessions load these files as instructions, so write each convention or constraint as a plain sentence that carries its reason, and match the length to what the directory needs, with no filler sections.

### Subdirectory AGENTS.md (Parallel)

Same bar, scoped to the directory: what differs from the parent, and why.

## Phase 4: Review & Deduplicate

Remove generic advice and anything a parent file already says. Keep the reason attached to each rule that survives.

## Anti-Patterns

- Ignoring existing → ALWAYS read first, even with --create-new
- Over-documenting → not every dir needs AGENTS.md
- Redundancy → child never repeats parent
- Generic content → remove anything applying to ALL projects
