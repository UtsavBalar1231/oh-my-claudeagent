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
	ruff check servers/

# ── Format ────────────────────────────────────────────────────────

# Format Python with ruff
[group('format')]
fmt:
	ruff format servers/

# Check Python formatting without changes
[group('format')]
fmt-check:
	ruff format --check servers/

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
	uv sync --group dev
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

# Stamp current HEAD SHA and sync version into marketplace.json, pyproject.toml, and claudemd.md
[group('release')]
release:
	#!/usr/bin/env bash
	set -euo pipefail
	SHA=$(git rev-parse HEAD)
	VERSION=$(jq -r '.version' .claude-plugin/plugin.json)
	# Stamp SHA into marketplace.json
	jq --arg sha "$SHA" '.plugins[0].source.sha = $sha' .claude-plugin/marketplace.json > /tmp/marketplace-tmp.json
	mv /tmp/marketplace-tmp.json .claude-plugin/marketplace.json
	echo "Stamped SHA: $SHA"
	# Sync version from plugin.json into pyproject.toml and claudemd.md
	sed -i "s/^version = \".*\"/version = \"${VERSION}\"/" pyproject.toml
	sed -i "s/^version: .*/version: ${VERSION}/" templates/claudemd.md
	echo "Synced version: $VERSION"
