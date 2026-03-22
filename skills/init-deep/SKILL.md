---
name: init-deep
description: Generate hierarchical AGENTS.md files. Root + complexity-scored subdirectories.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, TaskCreate, TaskUpdate, TaskList
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

---

## Workflow (High-Level)

1. **Discovery + Analysis** (concurrent)
   - Fire background explore agents immediately
   - Main session: bash structure + codemap + read existing AGENTS.md
2. **Score & Decide** - Determine AGENTS.md locations from merged findings
3. **Generate** - Root first, then subdirs in parallel
4. **Review** - Deduplicate, trim, validate

**Use TaskCreate for ALL phases. Mark in_progress → completed in real-time via TaskUpdate.**

---

## Phase 1: Discovery + Analysis (Concurrent)

### Fire Background Explore Agents IMMEDIATELY

Don't wait—these run async while main session works.

```
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Project structure: PREDICT standard patterns for detected language → REPORT deviations only")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Entry points: FIND main files → REPORT non-standard organization")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Conventions: FIND config files (.eslintrc, pyproject.toml, .editorconfig) → REPORT project-specific rules")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Anti-patterns: FIND 'DO NOT', 'NEVER', 'ALWAYS', 'DEPRECATED' comments → LIST forbidden patterns")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Build/CI: FIND .github/workflows, Makefile → REPORT non-standard patterns")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Test patterns: FIND test configs, test structure → REPORT unique conventions")
```

### Main Session: Concurrent Analysis

**While background agents run**, main session does:

#### 1. Bash Structural Analysis
```bash
# Directory depth + file counts
find . -type d -not -path '*/\.*' -not -path '*/node_modules/*' -not -path '*/venv/*' -not -path '*/dist/*' -not -path '*/build/*' | awk -F/ '{print NF-1}' | sort -n | uniq -c

# Files per directory (top 30)
find . -type f -not -path '*/\.*' -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30

# Code concentration by extension
find . -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) -not -path '*/node_modules/*' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

# Existing AGENTS.md / CLAUDE.md
find . -type f \( -name "AGENTS.md" -o -name "CLAUDE.md" \) -not -path '*/node_modules/*' 2>/dev/null
```

#### 2. Read Existing AGENTS.md

For each existing file found: Read and extract key insights, conventions, anti-patterns.

If `--create-new`: Read all existing first (preserve context) → then delete all → regenerate.

#### 3. LSP Codemap (if available)

Check whether Claude Code or another installed plugin exposes LSP tools, and use them to map entry points:

```
lsp_servers()                                          # Check what's running
lsp_document_symbols(filePath="src/index.ts")          # Entry point symbols
lsp_workspace_symbols(query="class")                   # All classes
lsp_workspace_symbols(query="interface")               # All interfaces
```

These are optional Claude-native or separately installed LSP capabilities, not something this plugin bundles or configures.
If LSP tools are unavailable, rely on explore agents and bash analysis only.

#### 4. Dynamic Agent Spawning

Spawn ADDITIONAL explore agents based on project scale (max 5 total):

| Factor | Threshold | Additional Agents |
|--------|-----------|-------------------|
| Total files | >100 | +1 per 100 files |
| Total lines | >10k | +1 per 10k lines |
| Directory depth | ≥4 | +2 for deep exploration |
| Large files (>500 lines) | >10 files | +1 for complexity hotspots |
| Multiple languages | >1 | +1 per language |

```bash
total_files=$(find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | wc -l)
```

---

## Phase 2: Scoring & Location Decision

### Scoring Matrix

| Factor | Weight | High Threshold | Source |
|--------|--------|----------------|--------|
| File count | 3x | >20 | bash |
| Subdir count | 2x | >5 | bash |
| Code ratio | 2x | >70% | bash |
| Unique patterns | 1x | Has own config | explore |
| Module boundary | 2x | Has index.ts/__init__.py | bash |
| Symbol density | 2x | >30 symbols | lsp_workspace_symbols count |
| Reference centrality | 3x | >20 refs | lsp_find_references count |

### Decision Rules

| Score | Action |
|-------|--------|
| **Root (.)** | ALWAYS create |
| **>15** | Create AGENTS.md |
| **8-15** | Create if distinct domain |
| **<8** | Skip (parent covers) |

---

## Phase 3: Generate AGENTS.md

### Root AGENTS.md (Full Treatment)

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

**Quality gates**: 50-150 lines, no generic advice, no obvious info.

### Subdirectory AGENTS.md (Parallel)

Launch writing tasks for each location with 30-80 lines max.

---

## Phase 4: Review & Deduplicate

For each generated file:
- Remove generic advice
- Remove parent duplicates
- Trim to size limits
- Verify telegraphic style

---

## Anti-Patterns

- **Sequential execution**: MUST parallel (explore agents concurrent)
- **Ignoring existing**: ALWAYS read existing first, even with --create-new
- **Over-documenting**: Not every dir needs AGENTS.md
- **Redundancy**: Child never repeats parent
- **Generic content**: Remove anything that applies to ALL projects
- **Static agent count**: Vary agents based on project size/depth
