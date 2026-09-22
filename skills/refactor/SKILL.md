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
/oh-my-claudeagent:refactor <refactoring-target> [--scope=<file|module|project>] [--strategy=<safe|aggressive>]

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

Deterministic refactoring with codebase awareness: understand intent, map codebase, assess risk, plan the steps, execute with ast-grep MCP tools, verify after each change.

## PHASE 0: INTENT GATE

Classify and validate before acting.

| Signal | Classification | Action |
|--------|----------------|--------|
| Specific file/symbol | Explicit | Proceed to codebase analysis |
| "Refactor X to Y" | Clear transformation | Proceed to codebase analysis |
| "Improve", "Clean up" | Open-ended | Ask "What specific improvement?" when readings would change which code moves; otherwise state your reading and proceed |
| Ambiguous scope | Uncertain | Ask "Which modules/files?" |

## PHASE 1: CODEBASE ANALYSIS

Map the target before changing it: its definitions, every caller and importer, the
tests that exercise it, and sibling code that follows the same pattern. Search directly
with `ast_search` and Bash; a file- or module-scope refactor needs a handful of
searches, not subagents. Fan out to `explore` only for a `--scope=project` change whose
search areas are independent, one agent per area, each briefed completely in its first
prompt.

## PHASE 2: BUILD CODEMAP

Dependency graph and impact zones from Phase 1:

### Impact Zones

| Zone | Risk Level | Action |
|------|------------|--------|
| Core | HIGH | Extra verification |
| Consumers | MEDIUM | Standard verification |
| Edge | LOW | Quick check |

## PHASE 3: TEST ASSESSMENT

Find the tests that exercise the code you are about to change and run them once for a
green baseline. If no test would fail on a behavior change in that code, pause and
propose characterization tests first, and refuse `--strategy=aggressive` until they
exist.

## PHASE 4: PLAN GENERATION

Write the step list yourself from the codemap: atomic steps, each independently
verifiable, ordered by dependency, with exact file paths and how to roll each one back.
A refactor that needs an interview or owner decisions stops here: ask the user to run
`/oh-my-claudeagent:plan`, since a `prometheus` subagent runs without `AskUserQuestion`.

## PHASE 5: EXECUTE REFACTORING

Per step:

1. **Pre-Step**: Confirm the baseline is green before touching the step's files
2. **Execute**: Use ast-grep MCP tools for structural replacement, or Edit for targeted changes. For a symbol rename, find every reference first (`ast_search`, or the `LSP` tool's find-references where a language server is installed), then edit each site.
3. **Post-Step Verification**: Run typecheck + run tests
4. **Record Evidence**: After each verification, call `evidence_log(evidence_type="<build|test|lint>", command="<cmd>", exit_code=<code>, output_snippet="<output>")`, choosing the type that matches the command
5. **Complete**: Move to the next step only when verification passes

If a verification fails, revert that step to get back to green, then diagnose from the recorded failure output before retrying it.

## PHASE 6: FINAL VERIFICATION

Full test suite, type check, lint, build, final diagnostics. Record each with `evidence_log`, including its real exit code.

## CRITICAL RULES

A refactor preserves behavior, so never hide a behavior change to get green: no type
suppression (`as any`, `@ts-ignore`, `@ts-expect-error`), and no deleting or weakening a
test to make it pass. Preview structural rewrites with the ast-grep MCP tools' dry_run
where supported, and move to the next step only when the current one verifies.

## Deprecated Code & Library Migration

1. `librarian` for recommended modern alternative
2. No auto-upgrade unless user requests migration
3. Migration requested → fetch latest API docs first
