#!/usr/bin/env bash
# normalize.sh — normalization pipeline for golden-output replay harness.
# Reads from stdin, writes normalized output to stdout.
# Rules applied in most-specific-first order per the plan's normalization table.
# Compatible with BSD sed (macOS) and GNU sed.

# No set -euo pipefail — consistent with project hook-scripts.md convention.

sed -E \
	-e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(Z|[-+][0-9]{2}:?[0-9]{2})?/<TS>/g' \
	-e 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+ [-+][0-9]{4}/<TS>/g' \
	-e 's/[A-Z][a-z]{2,8}, [A-Z][a-z]{2,8} [0-9]{1,2}, [0-9]{4}/<HUMAN_DATE>/g' \
	-e 's/[A-Z][a-z]{2,8} [A-Z][a-z]{2,8} [0-9]{1,2} [0-9]{4}/<HUMAN_DATE>/g' \
	-e 's/Current hour: [0-9]+/Current hour: <HOUR>/g' \
	-e 's/"ms":[0-9]+/"ms":<MS>/g' \
	-e 's|\$[0-9]+|<PID>|g' \
	-e 's|/tmp/tmp\.[A-Za-z0-9]{6,}|<TMPFILE>|g' \
	-e 's|/tmp/bats-run-[A-Za-z0-9]+/test/[0-9]+/[A-Za-z0-9_-]+|<TMPFILE>|g' \
	-e 's|/tmp/bats-[A-Za-z0-9._-]+|<TMPFILE>|g' \
	-e 's/(plan_sha256:[0-9a-f]{64})/\1/g' \
	-e 's/[0-9a-f]{32,64}/<HASH>/g' \
	-e 's/\b[0-9]{10,19}\b/<NUM>/g' \
	-e 's/\b[0-9]{10}\b/<EPOCH>/g'
