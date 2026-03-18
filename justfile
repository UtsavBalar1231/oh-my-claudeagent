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

# ── CI ────────────────────────────────────────────────────────────

# Run full CI pipeline (format check + lint + test)
[group('ci')]
ci: fmt-check lint test

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
	# Sync version into servers/pyproject.toml and claudemd.md (portable sed)
	if sed --version >/dev/null 2>&1; then
		sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" servers/pyproject.toml
		sed -i "s/^version: .*/version: ${VERSION}/" templates/claudemd.md
	else
		sed -i '' "s/^version = \".*\"/version = \"${VERSION}\"/" servers/pyproject.toml
		sed -i '' "s/^version: .*/version: ${VERSION}/" templates/claudemd.md
	fi
	echo "Synced version: $VERSION"
	# Update lockfile after pyproject.toml version change
	uv lock --project servers
	echo "Updated uv.lock"
	# Commit 1: version bump across all manifests
	git add .claude-plugin/plugin.json .claude-plugin/marketplace.json \
		servers/pyproject.toml templates/claudemd.md servers/uv.lock
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
