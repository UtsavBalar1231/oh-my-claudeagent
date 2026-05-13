"""Regression test: token-count + api-duration reads use nested paths per v2.1.132 schema."""
from __future__ import annotations

from statusline.core import _compose_line2


# Minimal glyph set used by the function; values are display-only so any
# placeholder strings work for the assertion checks.
GLYPHS = {
    "cost": "$",
    "clock": "⏱",
    "added": "+",
    "removed": "-",
}


def _payload_with_context_window() -> dict:
    return {
        "model": {"display_name": "Opus", "id": "claude-opus-4-7"},
        "session_id": "test-session",
        "context_window": {
            "total_input_tokens": 15000,
            "total_output_tokens": 1200,
            "context_window_size": 200000,
            "used_percentage": 8.0,
            "remaining_percentage": 92.0,
        },
        "cost": {
            "total_cost_usd": 0.0,
            "total_duration_ms": 1000,
            "total_api_duration_ms": 500,
            "total_lines_added": 0,
            "total_lines_removed": 0,
        },
    }


def test_token_display_reads_from_context_window() -> None:
    line = _compose_line2(_payload_with_context_window(), GLYPHS)
    # The token-display segment should render — `_format_tokens(16200)` produces
    # a human form like "16.2k" or "16k". Assert against any plausible rendering
    # of (15000 + 1200) = 16200.
    assert "tok" in line, f"Line 2 missing token segment: {line!r}"
    assert ("16.2k" in line) or ("16k" in line) or ("16200" in line), (
        f"Line 2 token segment did not render 16200 (15000+1200): {line!r}"
    )


def test_api_duration_reads_from_cost() -> None:
    line = _compose_line2(_payload_with_context_window(), GLYPHS)
    # Payload has cost.total_api_duration_ms == 500 → "api 0s" (integer-floor of 500//1000)
    assert "api " in line, f"Line 2 missing api-duration segment: {line!r}"


def test_token_segment_absent_when_context_window_missing() -> None:
    payload = {
        "model": {"display_name": "Opus", "id": "claude-opus-4-7"},
        "session_id": "test-session",
        "cost": {"total_cost_usd": 0.0, "total_duration_ms": 0},
    }
    line = _compose_line2(payload, GLYPHS)
    # No context_window means no token segment; `cost.total_cost_usd: 0.0`
    # produces the "$0.00" segment but ` tok` should not appear.
    assert " tok" not in line, f"Line 2 unexpectedly rendered tok with no context_window: {line!r}"


def test_token_segment_absent_when_zero_tokens() -> None:
    """Pre-first-API-call payload: context_window present with zero tokens.

    Per statusline.md, total_input_tokens and total_output_tokens are 0 before
    the first API response. Rendering "0 tok" in that state is noise; the
    v2.2.0 fix tightens the render condition to require a positive sum.
    """
    payload = {
        "model": {"display_name": "Opus", "id": "claude-opus-4-7"},
        "session_id": "test-session",
        "context_window": {
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "context_window_size": 200000,
            "used_percentage": 0.0,
        },
        "cost": {"total_cost_usd": 0.0, "total_duration_ms": 0},
    }
    line = _compose_line2(payload, GLYPHS)
    assert " tok" not in line, (
        f"Line 2 rendered token segment with zero counts (pre-first-API-call noise): {line!r}"
    )
