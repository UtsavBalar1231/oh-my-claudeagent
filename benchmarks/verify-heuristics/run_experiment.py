"""Run every candidate in candidates.py against the corpus and compute
false-block / false-pass rates per PROTOCOL.md.

Usage: python3 run_experiment.py
"""

from __future__ import annotations

import json
from pathlib import Path

from candidates import CANDIDATES

# 5 -- minimum true-incomplete count before false-pass is reportable.
# Fixed in PROTOCOL.md before this script existed.
MIN_TRUE_INCOMPLETE = 5


def load_corpus() -> list[dict]:
    base = Path(__file__).parent / "corpus"
    real = json.loads((base / "real_events.json").read_text(encoding="utf-8"))
    synthetic = json.loads((base / "synthetic_events.json").read_text(encoding="utf-8"))
    return real + synthetic


def evaluate(events: list[dict]) -> dict:
    complete = [e for e in events if e["label"] == "true-complete"]
    incomplete = [e for e in events if e["label"] == "true-incomplete"]
    ambiguous = [e for e in events if e["label"] == "ambiguous"]

    report_false_pass = len(incomplete) >= MIN_TRUE_INCOMPLETE

    results = {}
    for name, fn in CANDIDATES.items():
        false_blocks = sum(1 for e in complete if fn(e))
        false_block_rate = false_blocks / len(complete) if complete else None

        false_pass_rate = None
        false_passes = None
        if report_false_pass:
            false_passes = sum(1 for e in incomplete if not fn(e))
            false_pass_rate = false_passes / len(incomplete)

        results[name] = {
            "false_blocks": false_blocks,
            "false_block_rate": false_block_rate,
            "false_passes": false_passes,
            "false_pass_rate": false_pass_rate,
        }

    return {
        "corpus_size": len(events),
        "true_complete": len(complete),
        "true_incomplete": len(incomplete),
        "ambiguous_excluded": len(ambiguous),
        "false_pass_reportable": report_false_pass,
        "candidates": results,
    }


def decide(report: dict) -> str:
    if not report["false_pass_reportable"]:
        return (
            f"KEEP CURRENT. true-incomplete count ({report['true_incomplete']}) is below the "
            f"pre-registered minimum ({MIN_TRUE_INCOMPLETE}); false-pass is not computed. "
            "One-sided false-block evidence cannot justify loosening the gate."
        )

    current = report["candidates"]["current"]
    for name, res in report["candidates"].items():
        if name in ("current", "null_control"):
            continue
        if res["false_pass_rate"] is None or current["false_pass_rate"] is None:
            continue
        if res["false_pass_rate"] > current["false_pass_rate"]:
            continue
        if current["false_block_rate"] is None or res["false_block_rate"] is None:
            continue
        improvement = current["false_block_rate"] - res["false_block_rate"]
        if improvement >= 0.05:
            return f"ADOPT {name}: false-block rate improves by {improvement:.1%}, false-pass rate does not regress."
    return "KEEP CURRENT. No candidate cleared all three pre-registered thresholds."


def main() -> None:
    events = load_corpus()
    report = evaluate(events)
    report["decision"] = decide(report)
    print(json.dumps(report, indent=2))
    out = Path(__file__).parent / "results.json"
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
