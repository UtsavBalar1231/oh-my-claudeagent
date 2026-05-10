set shell := ["bash", "-euo", "pipefail", "-c"]

# List available recipes
[group('meta')]
default:
	@just --list

# ── Lint ─────────────────────────────────────────────────────────

# Run all linters
[group('lint')]
lint: lint-shell lint-python

# Lint shell scripts with shellcheck
[group('lint')]
lint-shell:
	shellcheck scripts/*.sh

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

# Run pytest MCP tool tests
[group('test')]
test-pytest:
	uv run --project servers pytest servers/tests/ -v

# Run BATS behavioral tests for hook scripts
[group('test')]
test-bats:
	tests/bats/bats-core/bin/bats tests/bats/hooks/ tests/bats/unit/

# ── Scaffold ──────────────────────────────────────────────────────

# Scaffold a new agent
[group('scaffold')]
new-agent name:
	@echo "---" > agents/{{name}}.md
	@echo "name: {{name}}" >> agents/{{name}}.md
	@echo "description: TODO" >> agents/{{name}}.md
	@echo "model: sonnet" >> agents/{{name}}.md
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
	@echo "Edits made: $(cat .omca/logs/edits.jsonl 2>/dev/null | wc -l)"
	@echo "Evidence entries: $(jq '.entries | length' .omca/state/verification-evidence.json 2>/dev/null || echo 0)"
	@echo "Error counts: $(jq 'to_entries | map(.value) | add // 0' .omca/state/error-counts.json 2>/dev/null || echo 0)"
	@echo "Hook errors: $(cat .omca/logs/hook-errors.jsonl 2>/dev/null | wc -l)"

# ── Validate ─────────────────────────────────────────────────────

# Validate plugin structure with claude CLI (requires claude in PATH)
[group('validate')]
validate-plugin:
	command -v claude >/dev/null 2>&1 || { echo "claude CLI not found, skipping"; exit 0; }
	claude plugin validate .

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

# Run full CI pipeline (format check + lint + test + mcp)
[group('ci')]
ci: fmt-check lint test test-bats test-pytest test-mcp

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
		servers/pyproject.toml servers/uv.lock
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
