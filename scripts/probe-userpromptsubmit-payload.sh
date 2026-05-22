#!/bin/bash
# One-shot UserPromptSubmit payload capture. DO NOT register permanently in hooks/hooks.json.
INPUT=$(cat)
OUTFILE="${OMCA_PROBE_OUTPUT:-/tmp/userpromptsubmit-payload.jsonl}"
echo "${INPUT}" >> "${OUTFILE}"
exit 0
