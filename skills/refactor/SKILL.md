---
name: refactor
description: Intelligent refactoring with codebase awareness, test verification, and step-by-step execution.
user-invocable: true
argument-hint: "[target file or module]"
effort: high
---

# Intelligent Refactor

## Usage

```
/refactor <refactoring-target> [--scope=<file|module|project>] [--strategy=<safe|aggressive>]

Arguments:
  refactoring-target: What to refactor. Can be:
    - File path: src/auth/handler.ts
    - Symbol name: "AuthService class"
    - Pattern: "all functions using deprecated API"
    - Description: "extract validation logic into separate module"

Options:
  --scope: Refactoring scope (default: module)
    - file: Single file only
    - module: Module/directory scope
    - project: Entire codebase

  --strategy: Risk tolerance (default: safe)
    - safe: Conservative, maximum test coverage required
    - aggressive: Allow broader changes with adequate coverage
```

Deterministic refactoring with codebase awareness: understand intent, map codebase, assess risk, plan via prometheus, execute with ast-grep MCP tools, verify after each change.

## PHASE 0: INTENT GATE

Classify and validate before acting.

| Signal | Classification | Action |
|--------|----------------|--------|
| Specific file/symbol | Explicit | Proceed to codebase analysis |
| "Refactor X to Y" | Clear transformation | Proceed to codebase analysis |
| "Improve", "Clean up" | Open-ended | **MUST ask**: "What specific improvement?" |
| Ambiguous scope | Uncertain | **MUST ask**: "Which modules/files?" |

## PHASE 1: CODEBASE ANALYSIS

### Parallel Explore Agents

```
// Agent 1: Find the refactoring target
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Find all occurrences and definitions of [TARGET]")

// Agent 2: Find related code
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Find all code that imports, uses, or depends on [TARGET]")

// Agent 3: Find similar patterns
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Find similar code patterns to [TARGET] in the codebase")

// Agent 4: Find tests
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Find all test files related to [TARGET]")

// Agent 5: Architecture context
Agent(subagent_type="oh-my-claudeagent:explore", prompt="Find architectural patterns and module organization around [TARGET]")
```

## PHASE 2: BUILD CODEMAP

Dependency graph and impact zones from Phase 1:

### Impact Zones

| Zone | Risk Level | Action |
|------|------------|--------|
| Core | HIGH | Extra verification |
| Consumers | MEDIUM | Standard verification |
| Edge | LOW | Quick check |

## PHASE 3: TEST ASSESSMENT

| Coverage Level | Strategy |
|----------------|----------|
| HIGH (>80%) | Run existing tests after each step |
| MEDIUM (50-80%) | Run tests + add safety assertions |
| LOW (<50%) | **PAUSE**: Propose adding tests first |
| NONE | **BLOCK**: Refuse aggressive refactoring |

## PHASE 4: PLAN GENERATION

Delegate to prometheus:

```
Agent(
  subagent_type="oh-my-claudeagent:prometheus",
  prompt="Create a detailed refactoring plan for: [GOAL]. Codemap: [CODEMAP]. Coverage: [VERIFICATION_PLAN]. Requirements: atomic steps, each independently verifiable, ordered by dependency, with exact file paths and rollback strategy."
)
```

> **Nesting constraint**: Prometheus runs as a subagent (depth 1) and cannot delegate to metis or explore. Supply ALL necessary context in the prompt — include the full codemap, coverage data, and specific file paths so prometheus can plan without sub-research.

## PHASE 5: EXECUTE REFACTORING

Per step:

1. **Pre-Step**: Mark task in_progress, verify baseline
2. **Execute**: Use ast-grep MCP tools for structural replacement, or Edit for targeted changes. For symbol renaming, use `lsp_rename` only if the current Claude environment exposes it.
3. **Post-Step Verification**: Run typecheck + run tests
4. **Record Evidence**: After each verification, call `evidence_log(evidence_type="typecheck", command="<cmd>", exit_code=<code>, output_snippet="<output>")`
5. **Complete**: Mark task completed if verification passes

**If ANY verification fails**: STOP, REVERT, DIAGNOSE.

## PHASE 6: FINAL VERIFICATION

Full test suite, type check, lint, build, final diagnostics. `evidence_log` after EACH — task completion blocked without fresh evidence.

## CRITICAL RULES

**NEVER:**
- Skip typecheck/build verification after changes
- Proceed with failing tests
- Use `as any`, `@ts-ignore`, `@ts-expect-error`
- Delete tests to make them pass

**ALWAYS:**
- Understand before changing
- Preview before applying (use ast-grep MCP tools with dry_run where supported)
- Verify after every change
- Follow existing codebase patterns

## Deprecated Code & Library Migration

1. `librarian` for recommended modern alternative
2. No auto-upgrade unless user requests migration
3. Migration requested → fetch latest API docs first
