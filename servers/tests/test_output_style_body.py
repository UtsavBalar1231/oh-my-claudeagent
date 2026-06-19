"""The OMCA Default output style is deliberately lean.

It carries the minimal-code creed. The heavier orchestration, parallel-execution, and
evidence framing was relocated to the omca-setup block and the specialist agents so it
does not weigh on every turn. These tests assert the lean shape and that the relocated
content was not lost.
"""

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_OUTPUT_STYLE = _REPO_ROOT / "output-styles" / "omca-default.md"
_ORCH_BLOCK = _REPO_ROOT / "skills" / "omca-setup" / "orchestration-block.md"


def _body() -> str:
    return _OUTPUT_STYLE.read_text(encoding="utf-8")


def _orch_block() -> str:
    return _ORCH_BLOCK.read_text(encoding="utf-8")


def test_file_exists():
    """The output-style file must exist at the expected path."""
    assert _OUTPUT_STYLE.exists(), f"Missing: {_OUTPUT_STYLE}"


def test_frontmatter_fields():
    """YAML frontmatter must declare the required plugin metadata fields."""
    body = _body()
    assert "name: OMCA Default" in body, "frontmatter 'name: OMCA Default' absent"
    assert "force-for-plugin: true" in body, (
        "frontmatter 'force-for-plugin: true' absent"
    )
    assert "keep-coding-instructions: true" in body, (
        "frontmatter 'keep-coding-instructions: true' absent"
    )


def test_minimal_code_creed_present():
    """The lean style's load-bearing content is the minimal-code creed."""
    body = _body()
    assert "Write the minimum that solves the problem" in body, (
        "minimal-code creed absent from the output style"
    )
    assert "<coding_discipline>" in body, "<coding_discipline> tag absent"


def test_heavy_framing_absent():
    """The heavy always-on framing must not weigh on every turn via the output style.

    Regression guard: it was relocated to the omca-setup block and the agents.
    """
    body = _body()
    removed = [
        "<operating_principles>",
        "<delegation>",
        "<critical_rules>",
        "<entrypoints>",
        "<agent_catalog>",
        "<workflow>",
        "<parallel_execution>",
        "<verification>",
        "<file_reading>",
        "Treat Claude Code as the platform owner",
    ]
    for marker in removed:
        assert marker not in body, (
            f"heavy framing leaked back into the output style: {marker}"
        )


def test_relocated_content_preserved_in_omca_setup_block():
    """The orchestration and evidence guidance shed by the output style must still live
    in the omca-setup block, so it is relocated rather than lost.
    """
    block = _orch_block()
    assert "synchronous parallel" in block, (
        "parallel fan-out guidance absent from the omca-setup block"
    )
    assert "evidence_log" in block, (
        "evidence_log reference absent from the omca-setup block"
    )


def test_bats_canary_comments_absent():
    """bats-canary HTML comments must have been stripped from the output-style."""
    body = _body()
    assert "bats-canary" not in body, (
        "bats-canary comment found — must be absent from the output-style body"
    )
