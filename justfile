set shell := ["bash", "-euo", "pipefail", "-c"]

# List the recipes
default:
	@just --list

# Run everything CI runs
ci: lint typecheck validate test test-mod test-opencode smoke

# Lint the TypeScript with oxlint, failing on warnings
lint:
	bun x --bun oxlint --deny-warnings src servers statusline scripts hooks opencode tests benchmarks/compare

# Type check the mod project, the bun runtime project and the OpenCode adapter
typecheck:
	bun x --bun tsc --noEmit -p tsconfig.json
	bun x --bun tsc --noEmit -p tsconfig.runtime.json
	bun x --bun tsc --noEmit -p opencode

# Run every validator group, or the ones named with --check; the engine group skips without the claude CLI
validate *args:
	bun scripts/validate.ts {{ args }}

# Run the bun specs; the roots are explicit because a bare bun test also collects the mod tests
test:
	bun test --parallel src servers statusline scripts benchmarks/compare

# Run the mod tests; the argument is the plugin root
test-mod:
	claude plugin test .

# Run the OpenCode adapter specs; the ones that load OpenCode skip themselves without opencode on PATH
test-opencode:
	bun test opencode/

# Run one headless session with the packaged plugin against the mock model; needs the claude CLI
smoke:
	bun scripts/qa/ci-smoke.ts

# Run the manual QA harness against the mock model before a release; CI does not run it
qa:
	bun scripts/qa/session-smoke.ts
	bun scripts/qa/install-verify.ts
	bun scripts/qa/hook-live-probe.ts
	bun scripts/qa/statusline-probe.ts
	bun scripts/qa/mcp-live.ts
	bun scripts/qa/worktree-bash.ts
	bun scripts/qa/worktree-bash.ts --unfiltered-tool-call
	bun scripts/qa/agent-effort.ts

# Capture one tests/mod/visual view in tmux at 80, 120 and 200 columns, or at --sizes
visual view *args:
	bun scripts/qa/visual.ts {{ view }} {{ args }}

# Recapture the README screens against the mock model; name shots, or `clips` for the video footage
screenshots *args:
	bun scripts/docs/screenshots.ts {{ args }}

# Render the demo video into video/out
video *args:
	cd video && bun install --frozen-lockfile && bun render.ts {{ args }}

# Benchmark the working tree, or --candidate-ref, against --baseline-ref
bench *args:
	bun scripts/bench.ts {{ args }}

# Compare OMCA with similar plugins in Docker; see benchmarks/compare/README.md
compare *args:
	bun benchmarks/compare/run.ts {{ args }}

# Refresh the committed engine types snapshot, which only a session load writes
types:
	claude -p --plugin-dir . "exit"

# Install the pre-commit git hooks
setup:
	pre-commit install

# Bump the version, tag it and commit the packaged tree to the plugin branch; never pushes
release version:
	bun scripts/release.ts '{{ version }}'
