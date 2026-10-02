set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes
[group('meta')]
default:
	@just --list

# ── Test ──────────────────────────────────────────────────────────

# Run the validation checks; the engine group skips without the claude CLI
[group('test')]
test:
	bun scripts/validate.ts --check claims --check hooks --check mod --check tree --check engine

# Run claims validation only
[group('test')]
test-claims:
	bun scripts/validate.ts --check claims

# Run hooks validation only
[group('test')]
test-hooks:
	bun scripts/validate.ts --check hooks

# Run the MCP server specs (requires ast-grep) and the handshake check against the real server
[group('test')]
test-mcp:
	bun test servers
	bun scripts/validate.ts --check mcp

# Run the OpenCode adapter suite (typecheck, then every spec, including the real-OpenCode smoke and model-path specs); skips without bun or opencode
[group('test')]
test-opencode:
	#!/usr/bin/env bash
	set -euo pipefail
	if ! command -v bun >/dev/null 2>&1 || ! command -v opencode >/dev/null 2>&1; then
		echo "SKIP test-opencode: bun or opencode not on PATH"
		exit 0
	fi
	bun install --frozen-lockfile
	bun run typecheck
	bun test opencode/

# Run the mod tests (tests/mod/*.test.ts). The argument is the plugin root; a test
# directory finds no hooks module.
[group('test')]
test-mod:
	claude plugin test .

# Run the bun spec files (*.spec.ts) under the explicit roots; bun test also collects
# *.test.ts, so a bare `bun test` would load mod tests that need the engine's test module.
[group('test')]
test-bun:
	bun test src servers statusline scripts opencode

# Run the manual QA harness: session smoke, install verify, the live hook probe, the statusline probe,
# the live MCP probe, then the worktree-bash and route-effort checks. Maintainer pre-release step, NOT part of CI: it launches
# real `claude` sessions against the mock model, each in a scratch project with its own CLAUDE_CONFIG_DIR.
[group('test')]
qa:
	bun scripts/qa/session-smoke.ts
	bun scripts/qa/install-verify.ts
	bun scripts/qa/hook-live-probe.ts
	bun scripts/qa/statusline-probe.ts
	bun scripts/qa/mcp-live.ts
	just qa-worktree-bash
	just qa-route-effort

# Capture tests/mod/visual/<view>.json in tmux against the mock model at 80, 120 and 200 columns
[group('test')]
visual view:
	bun scripts/qa/visual.ts {{ view }}

# Check against the mock model that a routing hint runs the subagent at effort low, with a no-hint control
[group('test')]
qa-route-effort:
	bun scripts/qa/route-effort.ts

# Check against the mock model that Bash works in an isolation: worktree subagent with the mod and its mcp_tool hooks loaded
[group('test')]
qa-worktree-bash *args:
	bun scripts/qa/worktree-bash.ts {{ args }}

# Benchmark the working tree (or --candidate-ref) against --baseline-ref, via the mock model
[group('test')]
bench *args:
	bun scripts/bench.ts {{ args }}

# ── Typecheck ────────────────────────────────────────────────────

# Type-check the mod project (engine types only) and the bun runtime project
[group('test')]
typecheck-ts:
	bun x tsc --noEmit -p tsconfig.json
	bun x tsc --noEmit -p tsconfig.runtime.json

# ── Scaffold ──────────────────────────────────────────────────────

# Scaffold a new agent
[group('scaffold')]
new-agent name:
	@case '{{ name }}' in *:*) echo "agent name must not contain ':', the platform rejects such an agent at load time" >&2; exit 1 ;; esac
	@echo "---" > agents/{{name}}.md
	@echo "name: {{name}}" >> agents/{{name}}.md
	@echo "description: TODO" >> agents/{{name}}.md
	@echo "model: opus" >> agents/{{name}}.md
	@echo "disallowedTools: Write, Edit" >> agents/{{name}}.md
	@echo "effort: medium" >> agents/{{name}}.md
	@echo "memory: project" >> agents/{{name}}.md
	@echo "maxTurns: 30" >> agents/{{name}}.md
	@echo "---" >> agents/{{name}}.md
	@echo "" >> agents/{{name}}.md
	@echo "# {{name}}" >> agents/{{name}}.md
	@echo "Created agents/{{name}}.md — update description, model, and disallowedTools"
	@echo "Remember to update: servers/categories.json and the <agent_catalog> block in output-styles/omca-default.md"

# ── Dev ───────────────────────────────────────────────────────────

# Install dev tools and pre-commit hooks
[group('dev')]
setup:
	just install-hooks

# Install pre-commit git hooks
[group('dev')]
install-hooks:
	pre-commit install

# Run all pre-commit hooks on all files
[group('dev')]
run-hooks:
	pre-commit run --all-files

# Check development prerequisites
[group('dev')]
doctor:
	@echo "=== oh-my-claudeagent Doctor ==="
	@which jq >/dev/null 2>&1 && echo "jq: $(jq --version)" || echo "jq: NOT FOUND (required)"
	@which bun >/dev/null 2>&1 && echo "bun: $(bun --version)" || echo "bun: NOT FOUND (required)"
	@which ast-grep >/dev/null 2>&1 && echo "ast-grep: $(ast-grep --version 2>&1 | head -1)" || (which sg >/dev/null 2>&1 && echo "ast-grep (sg): $(sg --version 2>&1 | head -1)" || echo "ast-grep: NOT FOUND (required)")
	@which pre-commit >/dev/null 2>&1 && echo "pre-commit: $(pre-commit --version)" || echo "pre-commit: NOT FOUND (recommended)"

# ── Docs ──────────────────────────────────────────────────────────

# Recapture the README screens in tmux against the mock model, then render them to SVG
[group('docs')]
screenshots:
	bun scripts/docs/screenshots.ts
	bun scripts/docs/render-svg.ts

# ── Validate ─────────────────────────────────────────────────────

# Run every validator group; the engine group skips without the claude CLI
[group('validate')]
validate:
	bun scripts/validate.ts

# Validate plugin structure with claude CLI (requires claude in PATH).
# Both positionals are needed: the repo root resolves only marketplace.json (whose plugin entry
# is a remote github source, so the local plugin.json is never opened), the manifest path walks
# plugin.json plus every skill and agent. The manifest run is non-strict because a CLAUDE.md at
# the plugin root draws a warning --strict promotes to an error; non-strict still exits 1 on a
# real frontmatter parse failure.
[group('validate')]
validate-plugin:
	command -v claude >/dev/null 2>&1 || { echo "claude CLI not found, skipping"; exit 0; }
	claude plugin validate .
	claude plugin validate .claude-plugin/plugin.json

# Validate the manifests with warnings promoted to errors. Catches a misspelled or
# leftover field that would load at runtime but should not be published. Skips silently
# where the claude CLI is absent so CI runners without it do not fail on this step.
[group('validate')]
validate-manifest:
	command -v claude >/dev/null 2>&1 || { echo "claude CLI not found, skipping"; exit 0; }
	claude plugin validate . --strict
	claude plugin validate .claude-plugin/plugin.json

# Validate the manifest and the hooks module. The manifest path is the target that opens
# register.ts; the repo root reads only marketplace.json. --strict is dropped while a local
# CLAUDE.md sits at the root, since its warning would fail every run.
[group('validate')]
validate-mod:
	claude plugin validate .claude-plugin/plugin.json $([[ -e CLAUDE.md ]] || echo --strict)

# Refresh the committed engine types snapshot in .claude-plugin/types/, which only a
# session load writes
[group('validate')]
types:
	claude -p --plugin-dir . "exit"

# Smoke test — verify plugin loads correctly (requires claude CLI)
[group('validate')]
smoke-test:
	@echo "=== Plugin Smoke Test ==="
	@echo "Checking plugin structure..."
	@just test-claims
	@echo "Checking hook scripts..."
	@just test-hooks
	@echo "Checking MCP tools..."
	@just test-mcp
	@echo ""
	@echo "All structural checks passed."
	@echo "For full integration test: claude --plugin-dir . -p 'What agents are available?'"

# ── Eval ──────────────────────────────────────────────────────────

# List available eval tasks and explain pass^k methodology
[group('eval')]
eval-consistency:
	@echo "=== oh-my-claudeagent Eval Consistency (pass^k) ==="
	@echo ""
	@echo "Methodology:"
	@echo "  Run each task k=3 times independently."
	@echo "  pass@1  — passes on at least 1 of 3 runs (any success)"
	@echo "  pass^3  — passes on all 3 runs (strict consistency)"
	@echo ""
	@echo "Available tasks:"
	@bun scripts/qa/eval-tasks.ts
	@echo ""
	@echo "To run a task: claude -p \"\$$(jq -r '.prompt' tests/evals/tasks/<name>.json)\" --plugin-dir . | tee output.log"
	@echo "Record results in tests/evals/results/<task>-trial-N.json"
	@echo "Automated multi-run execution is future work."

# Run all test suites (structural + MCP + every bun spec)
[group('test')]
test-all: test test-mcp test-bun

# ── CI ────────────────────────────────────────────────────────────

# Run full CI pipeline (typecheck, every validator group, mod tests, bun specs, MCP, manifest, opencode)
[group('ci')]
ci: typecheck-ts validate test-mod test-bun test-mcp validate-mod validate-manifest test-opencode

# ── Release ──────────────────────────────────────────────────────

# Bump the version, commit, stamp the bump commit's SHA in a second commit, and tag the bump commit. Never pushes. Usage: just release <version>
[group('release')]
release version:
	bun scripts/release.ts '{{ version }}'
