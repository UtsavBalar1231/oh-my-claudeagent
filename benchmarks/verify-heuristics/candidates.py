"""The three implementable gate candidates from PROTOCOL.md.

Each function takes one corpus event (as produced by extract_corpus.py or
hand-authored in corpus/synthetic_events.json) and returns True if the
candidate would BLOCK the event, False if it would PASS.

The session-scoped alternative is documented-only in PROTOCOL.md (Stage 1,
candidate 3) and has no function here -- it is not implemented in this
experiment.
"""

from __future__ import annotations


def current(event: dict) -> bool:
    """scripts/task-completed-verify.sh as it stands today: keyword regex
    OR-gated with evidence-file mtime <= 300s."""
    if event["recent_evidence"]:
        return False
    return bool(event["needs_evidence_keyword"])


def no_new_state(event: dict) -> bool:
    """Keyword regex, but recent evidence only counts if its command text
    shares a significant word with the task description."""
    if event["recent_evidence"] and event["evidence_command_overlap"]:
        return False
    return bool(event["needs_evidence_keyword"])


def null_control(event: dict) -> bool:
    """No gate. Calibration baseline."""
    return False


CANDIDATES = {
    "current": current,
    "no_new_state": no_new_state,
    "null_control": null_control,
}
