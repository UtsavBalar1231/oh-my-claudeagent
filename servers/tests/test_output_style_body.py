"""Assert orchestration content is present in the OMCA Default output-style body."""

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_OUTPUT_STYLE = _REPO_ROOT / "output-styles" / "omca-default.md"


def _body() -> str:
    return _OUTPUT_STYLE.read_text(encoding="utf-8")


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


def test_operating_principles_anchor():
    """Operating-principles intro sentence must be present."""
    body = _body()
    assert "Treat Claude Code as the platform owner" in body, (
        "operating-principles anchor sentence absent"
    )


def test_xml_section_tags():
    """Surviving orchestration XML section tags must be present."""
    body = _body()
    tags = [
        "<operating_principles>",
        "<coding_discipline>",
        "<delegation>",
        "<critical_rules>",
    ]
    for tag in tags:
        assert tag in body, f"XML section tag absent: {tag}"


def test_removed_xml_sections_absent():
    """Tags removed in T21 trim must NOT be present (regression guard)."""
    body = _body()
    removed = [
        "<entrypoints>",
        "<agent_catalog>",
        "<workflow>",
        "<parallel_execution>",
        "<verification>",
        "<file_reading>",
    ]
    for tag in removed:
        assert tag not in body, (
            f"Removed XML section tag found (should be absent): {tag}"
        )


def test_background_agent_barrier_marker():
    """Background-agent barrier heading must be present in critical_rules."""
    body = _body()
    assert "Background-agent barrier" in body, "'Background-agent barrier' absent"


def test_evidence_rule_marker():
    """Evidence-before-completion rule must reference evidence_log."""
    body = _body()
    assert "evidence_log" in body, "'evidence_log' reference absent"


def test_bats_canary_comments_absent():
    """bats-canary HTML comments must have been stripped from the output-style."""
    body = _body()
    assert "bats-canary" not in body, (
        "bats-canary comment found — must be absent from the output-style body"
    )
