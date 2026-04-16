---
name: init-deep
description: Generate hierarchical AGENTS.md files. Root + complexity-scored subdirectories.
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

1. **Discovery + Analysis** (concurrent) — explore agents + bash structure + codemap + existing AGENTS.md
2. **Score & Decide** — AGENTS.md locations from merged findings
3. **Generate** — root first, subdirs in parallel
4. **Review** — deduplicate, trim, validate

Use TaskCreate for ALL phases. Mark in_progress → completed in real-time.

## Phase 1: Discovery + Analysis (Concurrent)

### Background Explore Agents (launch immediately)

```
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Project structure: PREDICT standard patterns for detected language → REPORT deviations only")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Entry points: FIND main files → REPORT non-standard organization")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Conventions: FIND config files (.eslintrc, pyproject.toml, .editorconfig) → REPORT project-specific rules")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Anti-patterns: FIND 'DO NOT', 'NEVER', 'ALWAYS', 'DEPRECATED' comments → LIST forbidden patterns")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Build/CI: FIND .github/workflows, Makefile → REPORT non-standard patterns")
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Test patterns: FIND test configs, test structure → REPORT unique conventions")
```

### Background Agent Barrier

Agent completes but others running → acknowledge briefly, END response. Do NOT merge or proceed until ALL reported.

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

Optional Claude-native/plugin LSP tools for entry points: `lsp_servers()`, `lsp_document_symbols()`, `lsp_workspace_symbols()`. If unavailable, rely on explore agents and bash only.

#### 4. Dynamic Agent Spawning

Additional explore agents based on project scale (max 5 total):

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

Quality gates: 50-150 lines, no generic advice, no obvious info.

### Subdirectory AGENTS.md (Parallel)

30-80 lines max per location.

## Phase 4: Review & Deduplicate

Remove: generic advice, parent duplicates. Trim to limits. Verify telegraphic style.

## Anti-Patterns

- Sequential execution → MUST parallel
- Ignoring existing → ALWAYS read first, even with --create-new
- Over-documenting → not every dir needs AGENTS.md
- Redundancy → child never repeats parent
- Generic content → remove anything applying to ALL projects
- Static agent count → vary by project size/depth
