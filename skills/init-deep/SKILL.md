---
name: init-deep
description: "Use to generate or refresh hierarchical AGENTS.md files for a new, unfamiliar or restructured codebase (\"init deep\", \"generate AGENTS.md\")."
user-invocable: true
argument-hint: "[--create-new]"
effort: medium
---

# /init-deep

Writes an AGENTS.md at the repository root and in each subdirectory that needs its own.

## Usage

```
/init-deep                      # Refresh the files that exist and add any that are now needed
/init-deep --create-new         # Read the existing files, delete them, then write new ones
```

## Workflow

1. **Survey** the repository: explorer agents, the shell pass below, symbols, existing AGENTS.md files
2. **Choose** which directories get a file
3. **Write** the root file first, then the subdirectories in parallel
4. **Trim** repetition and anything generic

## Phase 1: survey the repository

### Background explorer agents

Each explorer agent re-reads the repository from scratch and hands back a report you then read, so delegate only the tracks the Bash pass below cannot answer in a few reads: none for a small repository, and at most five in total for a large one. Launch the ones you choose together in one message, and brief each with its directory scope and what to report. Candidate tracks:

- Entry points and non-standard organization
- Config files (linters, formatters, `pyproject.toml`) and the project-specific rules they encode
- Comments that mark forbidden or deprecated patterns (`DO NOT`, `NEVER`, `DEPRECATED`), with the reason each gives
- Build and CI (.github/workflows, Makefile) where it departs from the defaults
- Test configuration and layout

### Background agent barrier

Merge the explorer findings only after every agent has reported. Until then, carry on with the main-session analysis below, which does not overlap theirs; when it is done and agents are still running, end the turn once instead of answering each notification with a holding message.

### Main session, alongside the agents

#### 1. Shell pass

Tracked files already leave out dependencies and build output. Outside a git repository, get the same answers with `Glob`.

```bash
git ls-files | awk -F/ '{print NF-1}' | sort -n | uniq -c
git ls-files | grep / | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30
git ls-files | sed -n 's/.*\.\([^./]*\)$/\1/p' | sort | uniq -c | sort -rn | head -10
git ls-files | grep -E '(^|/)(AGENTS|CLAUDE)\.md$'
```

These print how deep the tree goes, its busiest directories, its file types and the instruction files it holds.

#### 2. Read existing AGENTS.md

Note what they record: conventions, prohibitions and the reasons given. With `--create-new`, read them before deleting so that knowledge carries over.

#### 3. LSP codemap (if available)

If the `LSP` tool is active (it needs a code-intelligence plugin for the language), use it to list the symbols in entry-point files, search symbols across the workspace, and find references into heavily used modules. Otherwise rely on the explorer agents and the Bash pass.

## Phase 2: scoring & location decision

The root always gets an AGENTS.md. A subdirectory gets one when an agent working inside it would need knowledge that neither the root file nor the code in front of it supplies. Signals, strongest first:

- Its own config, build, or test commands
- A module boundary that other code imports through (`index.ts`, `__init__.py`, a public API)
- Conventions or constraints that differ from its parent
- Code much of the repository depends on (many incoming references, when the `LSP` tool is active)
- Size: many files or subdirectories make the other signals likelier without being one

Leave a directory to its parent file when the parent already covers it. Every extra file costs context in each session that loads it.

## Phase 3: generate AGENTS.md

### Root AGENTS.md

```markdown
# Project knowledge base

## Overview
{What this is and what it is built with, in a sentence or two}

## Structure
{Tree with non-obvious purposes only}

## Finding your way
| To change | Look in | Why it is not obvious |

## House rules
{Only where this project departs from the norm for its stack}

## Do not
{What is forbidden here, each with its reason}

## Commands
{dev/test/build}
```

Quality bar: every line tells an agent something it could not infer from the code or from general knowledge of the stack. Later sessions load these files as instructions, so write each convention or constraint as a plain sentence that carries its reason, and match the length to what the directory needs, with no filler sections.

### Subdirectory AGENTS.md (parallel)

Same bar, scoped to the directory: what differs from the parent, and why.

## Phase 4: review & deduplicate

Remove generic advice and anything a parent file already says. Keep the reason attached to each rule that survives.

## Anti-patterns

Skip no existing file: `--create-new` reads them too. Most directories need no file of their own. A child file never repeats its parent, and a line that would hold for any project gets cut.
