---
name: github-triage
description: "Use to triage open GitHub issues and PRs in parallel, read-only, one executor per item (\"triage issues\", \"review open PRs\")."
model: opus
argument-hint: "[repo] [--issues-only | --prs-only]"
effort: medium
disallowed-tools: [Edit]
---

# GitHub triage: issue and PR processor

## Tool restrictions

Read-only GitHub and repository analysis. Do not modify repo files or GitHub state. Local report writes are allowed only under `.omca/scratch/github-triage-{datetime}/` in the project root. MCP tools: `notepad_write`, `evidence_log`, `ast_search`.

Fetch open issue/PR metadata, classify each, spawn 1 background executor per item. Each subagent fetches full details for its item and writes a report under `.omca/scratch/github-triage-{datetime}/` in the project root. Never take destructive action.

## Zero-action policy

This skill reads and reports; a human maintainer decides what happens to every item, and a mutation made during triage takes that decision away. Run only these read-only commands:

- `gh issue list`, `gh issue view`
- `gh pr list`, `gh pr view`
- `gh api --method GET repos/{REPO}/pulls/{number}/files`
- `gh repo view`

Never run a `gh` command that merges, closes, edits, comments on, labels, or reviews an item (`gh pr merge`, `gh pr close`, `gh issue close`, `gh issue edit`, `gh pr edit`, `gh pr review`), and never call `gh api` with `POST`, `PUT`, `PATCH`, or `DELETE`.

## Evidence rule (mandatory)

Every factual claim MUST cite a GitHub permalink containing a commit SHA. Branch permalinks (`blob/main`, `blob/master`, branch names) are forbidden.

Format:
```
CLAIM: "The handler for X is in Y"
EVIDENCE: https://github.com/{REPO}/blob/{COMMIT_SHA}/path/to/file.py#L42
```

Without a commit-SHA permalink, do not make the claim. Write "UNVERIFIED" instead.

Applies to: bug root cause (file + line), "feature exists" (cite where), "fix correct" (cite what), any code reference.

## Architecture

```
1 issue or PR  =  1 Agent(subagent_type="oh-my-claudeagent:executor")
```

| Rule | Value |
|------|-------|
| Agent type for ALL items | `oh-my-claudeagent:executor` |
| Execution mode | Background in an interactive session, where fork mode removes `run_in_background`; under `claude -p` and the Agent SDK a subagent may run in the foreground and return its result directly. Accept either |
| Parallelism | Bounded batches, max 5 concurrent agents |
| Total items per run | No platform cap. Bound the run yourself and record the overflow (see below) |
| Result storage | `issue-{number}.md` or `pr-{number}.md` under `.omca/scratch/github-triage-{datetime}/` in the project root |
| Final collection | Orchestrator reads all reports and writes `SUMMARY.md` |

---

## Phase 1: setup output directory

Set `{OUTDIR}` to the absolute path `<project root>/.omca/scratch/github-triage-<datetime>`, where `<datetime>` is the current date and time as `YYYYMMDD-HHMMSS`. When the session context gives only the date, append a short word of your own so two runs on one day get different directories. OMCA's server writes `.omca/.gitignore` when it starts, so reports stay out of commits.

Run no shell command to create the directory: the Write tool creates it when the first report is written. Tell the user the path now: `Reports will be written to: {OUTDIR}`.

---

## Phase 2: fetch open item metadata only

When no repo argument was given, run `gh repo view --json nameWithOwner -q .nameWithOwner` and use the `owner/name` it prints as `{REPO}` from here on.

```bash
# Issues: all open metadata only. Do not request body/comments here; control characters can break batching.
gh issue list --repo {REPO} --state open --limit 500 --json number,title,state,createdAt,updatedAt,labels,author

# PRs: all open metadata only. Subagents fetch body/comments/reviews/files per item.
gh pr list --repo {REPO} --state open --limit 500 --json number,title,state,createdAt,updatedAt,labels,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup
```

If either returns exactly 500 results, paginate using `--search "created:<LAST_CREATED_AT"` until exhausted.

---

## Phase 3: classify each item

For each item, determine its type from metadata only: title, labels, author, and PR state fields. Do not fetch body/comments during classification.

### Issues

Title prefixes and labels are strong signals. A `?` in a title is weak, because bug reports are often phrased as questions: an item that reports broken or unexpected behavior is `ISSUE_BUG` however it is phrased.

| Type | Signals |
|------|-----------|
| `ISSUE_BUG` | Title contains `[Bug]` or `Bug:`, labels indicate bug, or the title describes broken or unexpected behavior |
| `ISSUE_FEATURE` | Title contains `[Feature]`, `[RFE]`, `[Enhancement]`, `Feature Request`, `Proposal`, or labels indicate enhancement |
| `ISSUE_QUESTION` | Title contains `[Question]` or `[Discussion]`, or labels indicate question/discussion, and no defect is reported |
| `ISSUE_OTHER` | Anything else |

### PRs

| Type | Detection |
|------|-----------|
| `PR_BUGFIX` | Title starts with `fix`, `fix:`, `fix(`, branch contains `fix/` or `bugfix/`, or labels include `bug` |
| `PR_OTHER` | Everything else (feat, refactor, docs, chore, etc.) |

---

## Phase 4: spawn 1 background agent per item

### Run-size bound (decide before spawning anything)

No platform ceiling limits how many subagents a session spawns in total. The only
spawn limit that applies here is the concurrent one: the Agent tool refuses a spawn
with `Concurrent subagent limit reached` once the session's running count reaches
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20), and it starts succeeding again
as soon as running agents finish. Batches of 5 stay under that and under the
tool-call concurrency default of 10, so a batched run never trips it. A session
running with ultracode on is exempt from the concurrent limit entirely.

What actually bounds a run is wall-clock time and the orchestrator's own context:
every finished agent's result lands inline in this conversation. So the total is a
judgment call, not a constant. Pick a bound for the run, from the user's stated scope
if they gave one, otherwise from how large the classified list is against how much
room is left in the conversation. Then, if the classified list is longer than the
bound:

1. Sort by `updatedAt` descending and take the first N. Recently-touched items are
   the ones a triage pass is for.
2. Write the dropped items to `{OUTDIR}/SKIPPED.md`, one line per item: number,
   type, title, `updatedAt`. Never truncate silently.
3. State the count in `SUMMARY.md` and in your final message: how many items were
   triaged, how many were skipped, and that `SKIPPED.md` lists them.

A run that reports 120 of 340 items with the skipped list on disk is correct. A run
that reports those 120 as if they were all of them is a wrong answer.

For EVERY item that survives the bound, spawn one executor agent:

```text
Agent(
    subagent_type="oh-my-claudeagent:executor",
    prompt=SUBAGENT_PROMPT_FOR_TYPE
)
```

Launch agents in batches of up to 5 concurrent. Wait for batch to complete before launching next batch.

**Background Agent Barrier**: Each result arrives as a task notification, often in a later turn than the spawn. Launch the next batch, read reports, or write the summary only after every agent in the current batch has reported. While a batch runs, do work that does not overlap it, such as preparing the next batch's prompts; when none is left, end the turn once. Do not send a holding message on consecutive turns for the same batch, and do not re-spawn an item because its result has not arrived yet.

---

## Subagent prompt templates

### SUBAGENT_ISSUE_QUESTION

```
You are analyzing GitHub issue #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands (no gh issue close/edit/comment, no gh pr merge/edit/review, no gh api POST/PUT/PATCH/DELETE). REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Initial data is metadata-only; fetch full issue details yourself with read-only `gh issue view {number} --repo {REPO} --json body,comments`.

YOUR JOB:
1. Fetch and read the issue body/comments. Understand what the user is asking.
2. Search the codebase to find the answer: `ast_search` for a syntactic target (a signature, a call site, an import), `rg` for literal text, then Read what you find.
3. Find specific file paths and code that address the question.

EVIDENCE RULE: Every factual code claim must cite a GitHub permalink with commit SHA. If you cannot cite evidence, mark the claim UNVERIFIED.

Write your report to: {OUTDIR}/issue-{number}.md

Report format:
# Issue #{number}: {title}
**Type:** ISSUE_QUESTION
**Status:** ANSWERED | PARTIAL | UNANSWERABLE

## Analysis
[Your findings with evidence]

## Evidence
[File paths and code references for each claim]
EVIDENCE: <commit-SHA GitHub permalink> - [description]

## Recommended Response
[Draft response text for a maintainer to post - do NOT post it yourself]

## Action Required
[What a human maintainer should do]
```

---

### SUBAGENT_ISSUE_BUG

```
You are analyzing GitHub issue #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands (no gh issue close/edit/comment, no gh pr merge/edit/review, no gh api POST/PUT/PATCH/DELETE). REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Initial data is metadata-only; fetch full issue details yourself with read-only `gh issue view {number} --repo {REPO} --json body,comments`.

YOUR JOB:
1. Fetch and read the issue body/comments. Identify expected vs actual behavior and reproduction steps.
2. Search the codebase for the relevant code path.
3. Determine: confirmed bug, not a bug (behavior is correct), or unclear.

EVIDENCE RULE: For CONFIRMED_BUG, cite commit-SHA permalinks for exact code lines. No citation = UNVERIFIED. For NOT_A_BUG, cite commit-SHA permalinks proving correct behavior.

Write your report to: {OUTDIR}/issue-{number}.md

Report format:
# Issue #{number}: {title}
**Type:** ISSUE_BUG
**Verdict:** CONFIRMED_BUG | NOT_A_BUG | NEEDS_INVESTIGATION

## Root Cause (if CONFIRMED_BUG)
EVIDENCE: <commit-SHA GitHub permalink> - [what goes wrong and why]

## Proof of Correct Behavior (if NOT_A_BUG)
EVIDENCE: <commit-SHA GitHub permalink> - [code that shows intended behavior]

## Fix Approach (if CONFIRMED_BUG)
[Specific change needed - file, line, what to change]

## Severity
[LOW | MEDIUM | HIGH | CRITICAL] - [justification]

## Action Required
[What a human maintainer should do next]
```

---

### SUBAGENT_ISSUE_FEATURE

```
You are analyzing GitHub issue #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands, including gh api POST/PUT/PATCH/DELETE. REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Initial data is metadata-only; fetch full issue details yourself with read-only `gh issue view {number} --repo {REPO} --json body,comments`.

YOUR JOB:
1. Fetch and read the issue body/comments.
2. Search the codebase to check if this feature already exists (partially or fully).
3. Assess implementation feasibility.

EVIDENCE RULE: If you claim the feature exists, cite commit-SHA permalinks for the exact file and function.

Write your report to: {OUTDIR}/issue-{number}.md

Report format:
# Issue #{number}: {title}
**Type:** ISSUE_FEATURE
**Already Exists:** YES_FULLY | YES_PARTIALLY | NO

## Existence Evidence (if exists)
EVIDENCE: <commit-SHA GitHub permalink> - [how the feature is implemented]

## Feasibility
[EASY | MODERATE | HARD | ARCHITECTURAL_CHANGE]

## Relevant Files for Implementation
[Files that would need changes]

## Action Required
[What a human maintainer should do]
```

---

### SUBAGENT_ISSUE_OTHER

```
You are analyzing GitHub issue #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands, including gh api POST/PUT/PATCH/DELETE. REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Initial data is metadata-only; fetch full issue details yourself with read-only `gh issue view {number} --repo {REPO} --json body,comments`.

YOUR JOB:
1. Fetch and read the issue body/comments. Understand what the reporter is describing.
2. Search the codebase with `ast_search` or `rg`, then Read, to gather relevant context.
3. Determine the best classification and whether it needs maintainer attention.

EVIDENCE RULE: Every factual code claim must cite a GitHub permalink with commit SHA. If you cannot cite evidence, mark the claim UNVERIFIED.

Write your report to: {OUTDIR}/issue-{number}.md

Report format:
# Issue #{number}: {title}
**Type:** ISSUE_OTHER
**Best Classification:** QUESTION | BUG | FEATURE | DISCUSSION | META | STALE
**Needs Attention:** YES | NO
**Summary:** [1-2 sentence summary]

## Analysis
[Your findings with evidence]

## Evidence
[File paths and code references for each claim]
EVIDENCE: <commit-SHA GitHub permalink> - [description]

**Suggested Label:** [if any]
**Action Required:** [what a maintainer should do]
```

---

### SUBAGENT_PR_BUGFIX

```
You are analyzing GitHub PR #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands (no gh pr merge/close/edit, no gh pr review --approve, no gh api POST/PUT/PATCH/DELETE). REPORT ONLY. Read-only analysis via gh CLI and GET API only.

ITEM:
- PR #{number}: {title}
- Author: {author}
- Base: {baseRefName} <- Head: {headRefName}
- Draft: {isDraft}
- Mergeable: {mergeable}
- Review Decision: {reviewDecision}
- CI Status: {statusCheckRollup_summary}

YOUR JOB (READ-ONLY: no git checkout, no git fetch):
1. Fetch PR details: gh pr view {number} --repo {REPO} --json body,files,reviews,comments,statusCheckRollup,reviewDecision
2. Read changed files via: gh api --method GET repos/{REPO}/pulls/{number}/files
3. Search codebase to understand what the PR is fixing.
4. Assess merge safety against ALL six conditions.

MERGE CONDITIONS (report on each):
  a. CI status: ALL passing
  b. Review decision: APPROVED
  c. Fix is clearly correct, addressing an obvious, unambiguous bug
  d. No risky side effects (no architectural changes, no breaking changes)
  e. Not a draft PR
  f. Mergeable state is clean (no conflicts)

EVIDENCE RULE: For "fix is correct" assessment, cite original bug code and fix code with commit-SHA permalinks.

Write your report to: {OUTDIR}/pr-{number}.md

Report format:
# PR #{number}: {title}
**Type:** PR_BUGFIX
**Merge Safe:** YES (all 6 conditions met) | NO (list failing conditions)

## Fix Analysis
EVIDENCE: Original bug at <commit-SHA GitHub permalink>
EVIDENCE: Fix applied at <commit-SHA GitHub permalink> in PR diff

## Merge Condition Checklist
- [ ] CI: PASS | FAIL | PENDING
- [ ] Review: APPROVED | CHANGES_REQUESTED | PENDING | NONE
- [ ] Fix correctness: VERIFIED | UNVERIFIED
- [ ] Side effects: NONE | [describe]
- [ ] Draft: NO (good) | YES (blocks merge)
- [ ] Conflicts: NONE | [describe]

## Risk Assessment
[What could go wrong if merged]

## Action Required
[What a human maintainer should do - be specific]
```

---

### SUBAGENT_PR_OTHER

```
You are analyzing GitHub PR #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands, including gh api POST/PUT/PATCH/DELETE. READ-ONLY analysis only. No git checkout.

ITEM:
- PR #{number}: {title}
- Author: {author}
- Base: {baseRefName} <- Head: {headRefName}
- Draft: {isDraft}
- Mergeable: {mergeable}
- Review Decision: {reviewDecision}
- CI Status: {statusCheckRollup_summary}

YOUR JOB:
1. Fetch PR details: gh pr view {number} --repo {REPO} --json body,files,reviews,comments,statusCheckRollup
2. Read changed files via: gh api --method GET repos/{REPO}/pulls/{number}/files
3. Assess the PR.

Write your report to: {OUTDIR}/pr-{number}.md

Report format:
# PR #{number}: {title}
**Type:** PR_OTHER
**Subtype:** FEATURE | REFACTOR | DOCS | CHORE | TEST | OTHER
**Summary:** [what this PR does in 2-3 sentences]

## Status
- CI: PASS | FAIL | PENDING
- Review: APPROVED | CHANGES_REQUESTED | PENDING | NONE
- Conflicts: NONE | [describe]
- Draft: YES | NO

## Risk Level
[LOW | MEDIUM | HIGH] - [justification]

## Alignment
[Does this fit the project direction? YES | NO | UNCLEAR - cite evidence]

## Action Required
[NEEDS_REVIEW | REQUEST_CHANGES | WAIT_FOR_CI | CLOSE | other - with reason]
```

---

## Phase 5: collect results and write summary

After all background agents complete, read every per-item report from `{OUTDIR}/`
(`SKIPPED.md` is not a report; carry its count into the summary instead):

```bash
ls {OUTDIR}/issue-*.md {OUTDIR}/pr-*.md
```

Produce a final summary at `{OUTDIR}/SUMMARY.md`:

```markdown
# GitHub Triage Report: {REPO}

**Date:** {datetime}
**Output directory:** {OUTDIR}
**Items Processed:** {total}

## Issues ({issue_count})
| # | Title | Type | Verdict | Action Required |
|---|-------|------|---------|----------------|
| ... | ... | ... | ... | ... |

## Pull Requests ({pr_count})
| # | Title | Type | Merge Safe | Action Required |
|---|-------|------|------------|----------------|
| ... | ... | ... | ... | ... |

## Items Requiring Immediate Attention
[List each item where Action Required is non-trivial, with 1-line summary]

## Statistics
- Bugs confirmed: {bugs_confirmed}
- Questions answerable: {questions_answerable}
- PRs merge-safe: {prs_merge_safe}
- Needs human decision: {needs_human}

## Report Files
All individual reports in: {OUTDIR}/
```

Tell the user the output directory path when complete.

---

## Quick start

When invoked:

1. Choose the output directory: `.omca/scratch/github-triage-{datetime}/` under the project root, created by the first Write
2. Fetch open issue + PR metadata via gh CLI (paginate if 500 reached; no body/comments initially)
3. Classify each item (ISSUE_QUESTION, ISSUE_BUG, ISSUE_FEATURE, ISSUE_OTHER, PR_BUGFIX, PR_OTHER)
4. Decide the run-size bound; log any overflow to `{OUTDIR}/SKIPPED.md`
5. For EACH surviving item: `Agent(subagent_type="oh-my-claudeagent:executor", prompt=...)`
6. Launch agents in bounded batches of up to 5 concurrent executors
7. Collect reports from output directory once agents complete
8. Write `{OUTDIR}/SUMMARY.md` with aggregated findings
9. Report the output directory path to the user
