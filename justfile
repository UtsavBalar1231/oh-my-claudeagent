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

# Stamp HEAD SHA and sync version across all manifests. Usage: just release [version]
[group('release')]
release version="":
	#!/usr/bin/env bash
	set -euo pipefail
	SHA=$(git rev-parse HEAD)
	VERSION="{{ version }}"
	if [[ -z "${VERSION}" ]]; then
		VERSION=$(jq -r '.version' .claude-plugin/plugin.json)
	else
		# Update plugin.json with provided version
		jq --arg v "${VERSION}" '.version = $v' .claude-plugin/plugin.json > /tmp/plugin-tmp.json
		mv /tmp/plugin-tmp.json .claude-plugin/plugin.json
		echo "Updated plugin.json: $VERSION"
	fi
	# Stamp SHA and sync version into marketplace.json
	jq --arg sha "$SHA" --arg v "${VERSION}" '
		.plugins[0].source.sha = $sha |
		.metadata.version = $v |
		.plugins[0].version = $v
	' .claude-plugin/marketplace.json > /tmp/marketplace-tmp.json
	mv /tmp/marketplace-tmp.json .claude-plugin/marketplace.json
	echo "Stamped SHA: $SHA"
	# Sync version into servers/pyproject.toml and claudemd.md
	sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" servers/pyproject.toml
	sed -i "s/^version: .*/version: ${VERSION}/" templates/claudemd.md
	echo "Synced version: $VERSION"
