---
name: github-triage
description: Parallel triage of open GitHub issues and PRs — one background executor per item, read-only.
when_to_use: |
  Use when:
  - User wants to triage open GitHub issues or pull requests
  - Batch analysis of bugs, feature requests, or PR merge safety is needed
  - User says "triage issues", "review open PRs", or "what needs attention on GitHub"
model: sonnet
argument-hint: "[repo] [--issues-only | --prs-only]"
effort: medium
disallowed-tools: [Write, Edit]
---

# GitHub Triage — Unified Issue & PR Processor

## Tool Restrictions

Read-only GitHub and repository analysis. Do not modify repo files or GitHub state. Local report writes are allowed only under `/tmp/opencode/github-triage-{datetime}/`. MCP tools: `notepad_write`, `evidence_log`, `ast_search`.

Fetch open issue/PR metadata, classify each, spawn 1 background executor per item. Each subagent fetches full details for its item and writes a report under `/tmp/opencode/github-triage-{datetime}/`. Never take destructive action.

## Zero-Action Policy (NON-NEGOTIABLE)

**NEVER run any GitHub mutation command.** This skill is read-and-report ONLY.

Forbidden commands (automatic failure if used):
- `gh pr merge` — NEVER
- `gh pr close` — NEVER
- `gh issue close` — NEVER
- `gh issue edit` — NEVER
- `gh pr edit` — NEVER
- `gh pr review --approve` — NEVER
- `gh api` with non-GET methods — NEVER (`POST`, `PUT`, `PATCH`, `DELETE` are forbidden)
- Any `gh` command that writes, modifies, or deletes

Allowed read-only commands:
- `gh issue list`, `gh issue view`
- `gh pr list`, `gh pr view`
- `gh api --method GET repos/{REPO}/pulls/{number}/files`
- `gh repo view`

Violation = CRITICAL FAILURE. Report only; humans decide.

## Evidence Rule (MANDATORY)

Every factual claim MUST cite a GitHub permalink containing a commit SHA. Branch permalinks (`blob/main`, `blob/master`, branch names) are forbidden.

Format:
```
CLAIM: "The handler for X is in Y"
EVIDENCE: https://github.com/{REPO}/blob/{COMMIT_SHA}/path/to/file.py#L42
```

No commit-SHA permalink = cannot make the claim. Write "UNVERIFIED" instead.

Applies to: bug root cause (file + line), "feature exists" (cite where), "fix correct" (cite what), any code reference.

## ARCHITECTURE

```
1 issue or PR  =  1 Agent(subagent_type="oh-my-claudeagent:executor", run_in_background=true)
```

| Rule | Value |
|------|-------|
| Agent type for ALL items | `oh-my-claudeagent:executor` |
| Execution mode | `run_in_background=true` |
| Parallelism | Bounded batches, max 5 concurrent agents |
| Result storage | `issue-{number}.md` or `pr-{number}.md` under `/tmp/opencode/github-triage-{datetime}/` |
| Final collection | Orchestrator reads all reports and writes `SUMMARY.md` |

---

## PHASE 1: SETUP OUTPUT DIRECTORY

```bash
DATETIME=$(date +%Y%m%d-%H%M%S)
OUTDIR="/tmp/opencode/github-triage-${DATETIME}"
mkdir -p "${OUTDIR}"
echo "Reports will be written to: ${OUTDIR}"
```

---

## PHASE 2: FETCH OPEN ITEM METADATA ONLY

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Issues: all open metadata only. Do not request body/comments here; control characters can break batching.
gh issue list --repo $REPO --state open --limit 500 \
  --json number,title,state,createdAt,updatedAt,labels,author

# PRs: all open metadata only. Subagents fetch body/comments/reviews/files per item.
gh pr list --repo $REPO --state open --limit 500 \
  --json number,title,state,createdAt,updatedAt,labels,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup
```

If either returns exactly 500 results, paginate using `--search "created:<LAST_CREATED_AT"` until exhausted.

---

## PHASE 3: CLASSIFY EACH ITEM

For each item, determine its type from metadata only: title, labels, author, and PR state fields. Do not fetch body/comments during classification.

### Issues

| Type | Detection |
|------|-----------|
| `ISSUE_QUESTION` | Title contains `[Question]`, `[Discussion]`, or `?`, or labels indicate question/discussion |
| `ISSUE_BUG` | Title contains `[Bug]`, `Bug:`, or labels indicate bug |
| `ISSUE_FEATURE` | Title contains `[Feature]`, `[RFE]`, `[Enhancement]`, `Feature Request`, `Proposal`, or labels indicate enhancement |
| `ISSUE_OTHER` | Anything else |

### PRs

| Type | Detection |
|------|-----------|
| `PR_BUGFIX` | Title starts with `fix`, `fix:`, `fix(`, branch contains `fix/` or `bugfix/`, or labels include `bug` |
| `PR_OTHER` | Everything else (feat, refactor, docs, chore, etc.) |

---

## PHASE 4: SPAWN 1 BACKGROUND AGENT PER ITEM

For EVERY classified item, spawn one executor agent:

```python
Agent(
    subagent_type="oh-my-claudeagent:executor",
    run_in_background=True,
    prompt=SUBAGENT_PROMPT_FOR_TYPE
)
```

Launch agents in batches of up to 5 concurrent. Wait for batch to complete before launching next batch.

**Background Agent Barrier**: When a background agent completes but others in the batch are still running, acknowledge its result briefly (1-2 lines) and END your response immediately. Do NOT start collecting reports or writing the summary until ALL agents in the batch have completed. This prevents queued notifications from getting stuck.

---

## SUBAGENT PROMPT TEMPLATES

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
2. Search the codebase with Grep and Read to find the answer.
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
EVIDENCE: <commit-SHA GitHub permalink> — [description]

## Recommended Response
[Draft response text for a maintainer to post — do NOT post it yourself]

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
EVIDENCE: <commit-SHA GitHub permalink> — [what goes wrong and why]

## Proof of Correct Behavior (if NOT_A_BUG)
EVIDENCE: <commit-SHA GitHub permalink> — [code that shows intended behavior]

## Fix Approach (if CONFIRMED_BUG)
[Specific change needed — file, line, what to change]

## Severity
[LOW | MEDIUM | HIGH | CRITICAL] — [justification]

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
EVIDENCE: <commit-SHA GitHub permalink> — [how the feature is implemented]

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
2. Search the codebase with Grep and Read to gather relevant context.
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
EVIDENCE: <commit-SHA GitHub permalink> — [description]

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

YOUR JOB (READ-ONLY — no git checkout, no git fetch):
1. Fetch PR details: gh pr view {number} --repo {REPO} --json body,files,reviews,comments,statusCheckRollup,reviewDecision
2. Read changed files via: gh api --method GET repos/{REPO}/pulls/{number}/files
3. Search codebase to understand what the PR is fixing.
4. Assess merge safety against ALL six conditions.

MERGE CONDITIONS (report on each):
  a. CI status: ALL passing
  b. Review decision: APPROVED
  c. Fix is clearly correct — addresses an obvious, unambiguous bug
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
[What a human maintainer should do — be specific]
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
[LOW | MEDIUM | HIGH] — [justification]

## Alignment
[Does this fit the project direction? YES | NO | UNCLEAR — cite evidence]

## Action Required
[NEEDS_REVIEW | REQUEST_CHANGES | WAIT_FOR_CI | CLOSE | other — with reason]
```

---

## PHASE 5: COLLECT RESULTS AND WRITE SUMMARY

After all background agents complete, read every report file from `{OUTDIR}/`:

```bash
ls {OUTDIR}/*.md
```

Produce a final summary at `{OUTDIR}/SUMMARY.md`:

```markdown
# GitHub Triage Report — {REPO}

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

## ANTI-PATTERNS (AUTOMATIC FAILURE)

| Violation | Severity |
|-----------|----------|
| Running any gh mutation command (merge, close, edit, comment, review, non-GET API) | CRITICAL |
| Making claims without Evidence Rule citations | CRITICAL |
| Batching multiple items into one Agent call | CRITICAL |
| Using `run_in_background=false` | HIGH |
| Spawning any agent type other than executor | HIGH |
| Checking out PR branches via git | CRITICAL |
| Not writing report to `/tmp/opencode/github-triage-{datetime}/` | HIGH |
| Claiming feature exists without commit-SHA permalink citation | HIGH |

---

## QUICK START

When invoked:

1. Create output directory: `/tmp/opencode/github-triage-{datetime}/`
2. Fetch open issue + PR metadata via gh CLI (paginate if 500 reached; no body/comments initially)
3. Classify each item (ISSUE_QUESTION, ISSUE_BUG, ISSUE_FEATURE, ISSUE_OTHER, PR_BUGFIX, PR_OTHER)
4. For EACH item: `Agent(subagent_type="oh-my-claudeagent:executor", run_in_background=True, prompt=...)`
5. Launch agents in bounded batches of up to 5 concurrent executors
6. Collect reports from output directory once agents complete
7. Write `{OUTDIR}/SUMMARY.md` with aggregated findings
8. Report the output directory path to the user
