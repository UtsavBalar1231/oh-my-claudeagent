"""Extract a redacted, labeled corpus of task-completion events from this
project's own recorded session transcripts.

Reads ``~/.claude/projects/<slug>/*.jsonl`` (the platform's transcript
store), pairs each ``Agent`` tool_use with its tool_result, reconstructs
evidence-recency from ``evidence_log`` tool_use calls in the same file, and
labels each event true-complete / true-incomplete / ambiguous per the frozen
proxy rule in PROTOCOL.md. Only derived, non-sensitive fields are written to
the output fixture -- never raw prompt or result text.

Usage: python3 extract_corpus.py [--out corpus/real_events.json]
"""

from __future__ import annotations

import argparse
import glob
import json
import re
from datetime import datetime
from pathlib import Path

# Same slug algorithm as scripts/lib/common.sh and servers/tools/sessions.py.
_SLUG_RE = re.compile(r"[^A-Za-z0-9]")

KEYWORD_RE = re.compile(
    r"(^|[^a-zA-Z0-9])(verify|test|build|typecheck|lint|validate|fix|implement|refactor|deploy)([^a-zA-Z0-9]|$)",
    re.IGNORECASE,
)

REWORK_TOKENS = (
    "wrong",
    "bug",
    "gap",
    "gaps",
    "missed",
    "incomplete",
    "redo",
    "revisit",
    "broken",
    "regression",
)

STOPWORDS = {
    "the",
    "a",
    "an",
    "and",
    "or",
    "of",
    "to",
    "in",
    "for",
    "on",
    "with",
    "is",
    "are",
    "this",
    "that",
    "it",
    "at",
    "by",
    "vs",
}

# Repo-specific: this transcript corpus is meta-work about hooks/plans/agents,
# so these words appear in nearly every task description and carry no topical
# signal on their own (e.g. "Task 6: ..." vs "Task 7: ..." are unrelated).
DOMAIN_STOPWORDS = {
    "task",
    "tasks",
    "phase",
    "gate",
    "plan",
    "hook",
    "hooks",
    "agent",
    "agents",
    "review",
    "omca",
    "omc",
}

# 300s -- mirrors MAX_EVIDENCE_AGE_SECONDS in scripts/task-completed-verify.sh.
EVIDENCE_WINDOW_SECONDS = 300


def _slugify(path: str) -> str:
    return _SLUG_RE.sub("-", path)


def _parse_ts(ts: str) -> float | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _words(text: str) -> set[str]:
    return {
        w
        for w in re.findall(r"[a-z0-9]+", text.lower())
        if len(w) >= 4 and w not in STOPWORDS and w not in DOMAIN_STOPWORDS
    }


def _scan_file(path: Path) -> list[dict]:
    """Return raw (unredacted, in-memory only) events for one transcript file."""
    pending: dict[str, dict] = {}
    evidence_calls: list[dict] = []  # {ts, epoch, command}
    calls_in_order: list[dict] = []  # {ts, epoch, description, prompt}

    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            ts = rec.get("timestamp", "")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "tool_use" and block.get("name") == "Agent":
                    inp = block.get("input", {}) or {}
                    entry = {
                        "id": block.get("id"),
                        "description": inp.get("description", ""),
                        "prompt": inp.get("prompt", ""),
                        "subagent_type": inp.get("subagent_type", ""),
                        "call_ts": ts,
                        "call_epoch": _parse_ts(ts),
                    }
                    pending[block.get("id")] = entry
                    calls_in_order.append(entry)
                elif btype == "tool_use" and "evidence_log" in (
                    block.get("name") or ""
                ):
                    inp = block.get("input", {}) or {}
                    evidence_calls.append(
                        {
                            "ts": ts,
                            "epoch": _parse_ts(ts),
                            "command": inp.get("command", ""),
                        }
                    )
                elif btype == "tool_result":
                    tuid = block.get("tool_use_id")
                    if tuid in pending:
                        pending[tuid]["result_ts"] = ts
                        pending[tuid]["result_epoch"] = _parse_ts(ts)

    events = [
        e
        for e in pending.values()
        if "result_epoch" in e and e["result_epoch"] is not None
    ]
    return _label_events(events, calls_in_order, evidence_calls)


def _label_events(
    events: list[dict], calls_in_order: list[dict], evidence_calls: list[dict]
) -> list[dict]:
    out = []
    for e in events:
        desc_words = _words(e["description"])

        # Evidence-recency reconstruction: nearest preceding evidence_log call.
        best_delta = None
        best_command = ""
        for ev in evidence_calls:
            if ev["epoch"] is None or e["result_epoch"] is None:
                continue
            delta = e["result_epoch"] - ev["epoch"]
            if 0 <= delta and (best_delta is None or delta < best_delta):
                best_delta = delta
                best_command = ev["command"]

        recent_evidence = (
            best_delta is not None and best_delta <= EVIDENCE_WINDOW_SECONDS
        )
        command_overlap = (
            bool(desc_words & _words(best_command)) if recent_evidence else False
        )

        needs_evidence = bool(KEYWORD_RE.search(e["description"]))

        # Labeling proxy: scan later Agent calls in the same file for word
        # overlap + rework-signal token, per PROTOCOL.md.
        label = "true-complete"
        for later in calls_in_order:
            if later is e:
                continue
            if later["call_epoch"] is None or e["result_epoch"] is None:
                continue
            if later["call_epoch"] <= e["result_epoch"]:
                continue
            later_words = _words(later["description"])
            if not (desc_words & later_words):
                continue
            haystack = (later["description"] + " " + later["prompt"]).lower()
            if any(tok in haystack for tok in REWORK_TOKENS):
                label = "true-incomplete"
                break
            label = "ambiguous"
            # keep scanning: a later call might still hit true-incomplete

        out.append(
            {
                "description": e["description"],
                "subagent_type": e["subagent_type"],
                "needs_evidence_keyword": needs_evidence,
                "seconds_since_evidence": round(best_delta, 3)
                if best_delta is not None
                else None,
                "recent_evidence": recent_evidence,
                "evidence_command_overlap": command_overlap,
                "label": label,
                "synthetic": False,
            }
        )
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="corpus/real_events.json")
    parser.add_argument(
        "--project-root",
        default=str(Path(__file__).resolve().parents[2]),
        help="Project root used to derive the transcript slug (default: this repo).",
    )
    args = parser.parse_args()

    slug = _slugify(args.project_root)
    transcripts_dir = Path.home() / ".claude" / "projects" / slug
    files = sorted(glob.glob(str(transcripts_dir / "*.jsonl")))

    all_events: list[dict] = []
    for f in files:
        all_events.extend(_scan_file(Path(f)))

    out_path = Path(__file__).parent / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(all_events, indent=2) + "\n", encoding="utf-8")
    counts = {}
    for e in all_events:
        counts[e["label"]] = counts.get(e["label"], 0) + 1
    print(f"wrote {len(all_events)} events to {out_path}")
    print(f"label counts: {counts}")


if __name__ == "__main__":
    main()
