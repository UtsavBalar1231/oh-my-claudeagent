# REVIEW.md

Review-only instructions for this repository. `code-review.md` documents this file as a
managed Code Review surface: its contents are injected verbatim into every agent in that
review pipeline as the highest-priority instruction block. Two consequences shape what
belongs here.

- The local `/code-review` slash command does not read this file. It follows `CLAUDE.md`
  like any other session. So this file changes managed reviews only, and anything a local
  review must also know belongs in `CLAUDE.md` or `.claude/rules/`.
- `@` imports are not expanded and referenced files are not read into the prompt, so this
  file has to state its rules directly. It is a digest of `.claude/rules/`, not a copy, and
  `.claude/rules/` stays the authority. Keep it short: length dilutes the rules that matter.

## Flag these

**Hook scripts (`scripts/*.sh`)**

- `set -euo pipefail`. Hooks must degrade on missing state files.
- A state file written in place rather than through `mktemp` plus `mv`.
- A non-zero exit outside the sanctioned set. Only the turn-gate hook blocks by exiting 2;
  Stop hooks block with decision-control JSON on stdout and exit 0; the PreToolUse and
  PermissionRequest deny hooks exit 2 and write to stderr only. Removing an exit-2 path in
  a deny hook auto-approves the command that hook exists to block.
- A numeric constant with no derivation comment within two lines above it.
- Defensive doubling: a `jq` `//` default paired with `2>/dev/null || echo ""`, or a
  `${VAR:-0}` stacked on a `//` default. One default, not three.
- `grep -c PATTERN file || echo 0`, which emits two lines and breaks arithmetic. Use `|| true`.
- A new script that is not registered in `hooks/hooks.json`. Unregistered means dead.
- A `check_*`, `validate_*`, or `verify_*` function with side effects, or a mutating
  function without an action verb in its name.

**Python (`servers/`, `statusline/`)**

- Do not flag `Field()` in a function parameter default. FastMCP requires it and B008 is
  ignored on purpose.
- Flag an MCP tool docstring past 2KB and a `Field()` description that does not say when to
  reach for the tool.

**Agent and skill definitions**

- Any `tools:` key in agent frontmatter, with no exceptions. It is a strict allowlist that
  blocks MCP inheritance and an incomplete list launches the agent with zero usable tools.
  Restrictions go in `disallowedTools:`.
- A `permissionMode:` or `initialPrompt:` key, or a `:` inside `name:`. All three are inert
  or fatal in a plugin agent.
- A pinned generation id in `model:`. Agents declare a tier alias so frontmatter cannot go
  stale.
- A skill description past 512 characters.

**Prose in any tracked file**

- An inventory count: "N agents", "N skills", "N hooks", "three bundled servers". Docs
  enumerate contents and let the reader count.
- A version number, field name, or default that is not traceable to the docs mirror or a
  changelog line. State the source or drop the claim.
- A plan task number, plan filename, or "Task N of X" in a comment. Comments state the
  invariant, not the history.
- A comment that restates the line below it, or an AI-attribution line.
- Em dashes, en dashes, and marketing adjectives.

## Severity calibration

Treat a silent-failure defect as the top tier: a guardrail that stops denying, a gate that
stops enforcing, a state write that can clobber a concurrent session. A stale doc claim in
`OMCA.md` or `.claude/rules/` is next, because those files govern later authorship and a
false rule propagates. Style and wording are lowest; report them in one grouped finding
rather than one per line.
