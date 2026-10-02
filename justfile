set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes
[group('meta')]
default:
	@just --list

# ── Lint ─────────────────────────────────────────────────────────

# Run all linters
[group('lint')]
lint: lint-shell lint-python

# Lint shell scripts with shellcheck. scripts/*.sh is non-recursive by design, so
# scripts/qa/ (the qa harness, packaging-excluded) is listed explicitly rather than
# widening the glob to every subdirectory.
[group('lint')]
lint-shell:
	shellcheck scripts/*.sh scripts/qa/*.sh scripts/qa/lib/*.sh

# Lint Python with ruff
[group('lint')]
lint-python:
	uv run --project servers ruff check servers/

# ── Format ────────────────────────────────────────────────────────

# Format Python with ruff
[group('format')]
fmt:
	uv run --project servers ruff format servers/

# Check Python formatting without changes
[group('format')]
fmt-check:
	uv run --project servers ruff format --check servers/

# ── Test ──────────────────────────────────────────────────────────

# Run all validation suites
[group('test')]
test:
	bash scripts/validate-plugin.sh --check claims --check hooks

# Run claims validation only
[group('test')]
test-claims:
	bash scripts/validate-plugin.sh --check claims

# Run hooks validation only
[group('test')]
test-hooks:
	bash scripts/validate-plugin.sh --check hooks

# Run MCP validation only (requires ast-grep)
[group('test')]
test-mcp:
	bash scripts/validate-plugin.sh --check mcp

# Run the OpenCode adapter suite (typecheck, unit tests, smoke, model path); skips without bun or opencode
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
	bash opencode/test/smoke.sh
	bash opencode/test/model-path.sh

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

# Run the pytest suite
[group('test')]
test-pytest:
	uv run --project servers pytest servers/tests/ -v

# Run BATS behavioral tests for hook scripts
[group('test')]
test-bats:
	tests/bats/bats-core/bin/bats tests/bats/hooks/ tests/bats/unit/

# Run the claude-code-qa harness: packaged-plugin install/hook/statusline probes plus
# a skip-by-default session smoke test. Maintainer pre-release step, NOT part of CI --
# it launches real `claude` sessions against a scratch project under the real HOME
# (see scripts/qa/lib/qa-common.sh for the isolation model), so it stays local/manual.
[group('test')]
qa:
	bash scripts/qa/install-verify.sh
	bash scripts/qa/hook-live-probe.sh
	bash scripts/qa/statusline-probe.sh
	bash scripts/qa/session-smoke.sh
	bun scripts/qa/worktree-bash.ts

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

# Type-check servers/ with pyright (pinned as a servers/ dev dependency). Note: the pyright PyPI wrapper downloads/runs a Node
# runtime on first execution -- CI installs Node via actions/setup-node for this reason.
[group('test')]
typecheck:
	uv run --project servers pyright

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

# Scaffold a new hook script
[group('scaffold')]
new-hook event script-name:
	@echo '#!/usr/bin/env bash' > scripts/{{script-name}}.sh
	@echo '# {{event}} hook: {{script-name}}' >> scripts/{{script-name}}.sh
	@echo '' >> scripts/{{script-name}}.sh
	@echo 'INPUT=$$(cat)' >> scripts/{{script-name}}.sh
	@echo 'PROJECT_ROOT=$$(echo "$$INPUT" | jq -r '"'"'.project_root // ""'"'"' 2>/dev/null)' >> scripts/{{script-name}}.sh
	@echo 'STATE_DIR="$${PROJECT_ROOT:-.}/.omca/state"' >> scripts/{{script-name}}.sh
	@echo 'mkdir -p "$$STATE_DIR"' >> scripts/{{script-name}}.sh
	@echo '' >> scripts/{{script-name}}.sh
	@echo '# TODO: Add hook logic here' >> scripts/{{script-name}}.sh
	@echo '' >> scripts/{{script-name}}.sh
	@echo 'exit 0' >> scripts/{{script-name}}.sh
	@chmod +x scripts/{{script-name}}.sh
	@echo "Created scripts/{{script-name}}.sh — register in hooks/hooks.json under {{event}}"

# ── Dev ───────────────────────────────────────────────────────────

# Install dev tools and pre-commit hooks
[group('dev')]
setup:
	uv sync --project servers --group dev
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
	@which uv >/dev/null 2>&1 && echo "uv: $(uv --version)" || echo "uv: NOT FOUND (required)"
	@python3 --version 2>/dev/null || echo "python3: NOT FOUND (required)"
	@which ast-grep >/dev/null 2>&1 && echo "ast-grep: $(ast-grep --version 2>&1 | head -1)" || (which sg >/dev/null 2>&1 && echo "ast-grep (sg): $(sg --version 2>&1 | head -1)" || echo "ast-grep: NOT FOUND (required)")
	@which shellcheck >/dev/null 2>&1 && echo "shellcheck: $(shellcheck --version | grep version: | head -1)" || echo "shellcheck: NOT FOUND (recommended)"
	@which pre-commit >/dev/null 2>&1 && echo "pre-commit: $(pre-commit --version)" || echo "pre-commit: NOT FOUND (recommended)"
	@[[ -x tests/bats/bats-core/bin/bats ]] && echo "  bats: $(tests/bats/bats-core/bin/bats --version)" || echo "  bats: NOT FOUND (run: git submodule update --init)"

# Watch all OMCA log files in real-time
[group('dev')]
watch-logs:
	@tail -f .omca/logs/*.jsonl 2>/dev/null || echo "No log files found in .omca/logs/"

# ── Dev tools ────────────────────────────────────────────────────

# Analyze current session logs
[group('dev')]
analyze-session:
	@echo "=== Session Analysis ==="
	@echo "Agents spawned: $(cat .omca/logs/subagents.jsonl 2>/dev/null | wc -l)"
	@echo "Evidence entries: $(jq '.entries | length' .omca/state/verification-evidence.json 2>/dev/null || echo 0)"
	@echo "Hook errors: $(cat .omca/logs/hook-errors.jsonl 2>/dev/null | wc -l)"

# ── Validate ─────────────────────────────────────────────────────

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
	@bash tests/evals/run-eval.sh
	@echo ""
	@echo "To run a task: claude -p \"\$$(jq -r '.prompt' tests/evals/tasks/<name>.json)\" --plugin-dir . | tee output.log"
	@echo "Record results in tests/evals/results/<task>-trial-N.json"
	@echo "Automated multi-run execution is future work."

# Run all test suites (structural + behavioral + MCP)
[group('test')]
test-all: test test-bats test-pytest test-mcp

# ── CI ────────────────────────────────────────────────────────────

# Run full CI pipeline (format check + lint + typecheck + test + mcp + manifest + opencode + TypeScript checks)
[group('ci')]
ci: fmt-check lint typecheck test test-bats test-pytest test-mcp validate-manifest test-opencode typecheck-ts test-mod test-bun validate-mod

# ── Release ──────────────────────────────────────────────────────

# Bump version, commit, stamp SHA, and tag. Usage: just release [version]
[group('release')]
release version="":
	#!/usr/bin/env bash
	set -euo pipefail
	# Guard: abort if working tree is dirty
	if ! git diff --quiet || ! git diff --cached --quiet; then
		echo "ERROR: working tree has uncommitted changes. Commit or stash first." >&2
		exit 1
	fi
	VERSION="{{ version }}"
	if [[ -z "${VERSION}" ]]; then
		VERSION=$(jq -r '.version' .claude-plugin/plugin.json)
	else
		# Validate CHANGELOG has an entry for this version
		if ! grep -q "## \[${VERSION}\]" CHANGELOG.md; then
			echo "ERROR: no CHANGELOG.md entry for version ${VERSION}. Add one first." >&2
			exit 1
		fi
		# Update plugin.json with provided version
		jq --arg v "${VERSION}" '.version = $v' .claude-plugin/plugin.json > /tmp/plugin-tmp.json
		mv /tmp/plugin-tmp.json .claude-plugin/plugin.json
		echo "Updated plugin.json: $VERSION"
		jq --arg v "${VERSION}" '.version = $v' package.json > /tmp/package-tmp.json
		mv /tmp/package-tmp.json package.json
		echo "Updated package.json: $VERSION"
	fi
	# Sync version into marketplace.json (SHA stamped in a separate commit below)
	jq --arg v "${VERSION}" '
		.metadata.version = $v |
		.plugins[0].version = $v
	' .claude-plugin/marketplace.json > /tmp/marketplace-tmp.json
	mv /tmp/marketplace-tmp.json .claude-plugin/marketplace.json
	# Sync version into servers/pyproject.toml (portable sed)
	if sed --version >/dev/null 2>&1; then
		sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" servers/pyproject.toml
	else
		sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" servers/pyproject.toml
	fi
	echo "Synced version: $VERSION"
	# Update lockfile after pyproject.toml version change
	uv lock --project servers
	echo "Updated uv.lock"
	# Commit 1: version bump across all manifests
	git add .claude-plugin/plugin.json .claude-plugin/marketplace.json \
		servers/pyproject.toml servers/uv.lock package.json
	git commit -m "chore(release): bump version to ${VERSION}"
	echo "Committed version bump"
	# Commit 2: stamp the version-bump commit SHA into marketplace.json
	# (A commit can't contain its own SHA, so this must be a separate commit.
	#  Claude Code reads marketplace.json from HEAD but fetches the plugin tree
	#  at the stamped SHA — which is commit 1 with the correct version.)
	RELEASE_SHA=$(git rev-parse HEAD)
	jq --arg sha "$RELEASE_SHA" '.plugins[0].source.sha = $sha' \
		.claude-plugin/marketplace.json > /tmp/marketplace-tmp.json
	mv /tmp/marketplace-tmp.json .claude-plugin/marketplace.json
	git add .claude-plugin/marketplace.json
	git commit -m "chore(release): stamp v${VERSION} SHA"
	echo "Stamped SHA: $RELEASE_SHA"
	# Tag the version-bump commit (not the SHA-stamp commit)
	git tag -f "v${VERSION}" "$RELEASE_SHA"
	echo "Tagged v${VERSION} at ${RELEASE_SHA:0:7}"
	echo ""
	echo "Release ${VERSION} ready. Push with:"
	echo "  git push origin main --tags"
