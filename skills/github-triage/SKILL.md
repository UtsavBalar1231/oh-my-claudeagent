---
name: github-triage
description: "Unified GitHub triage for issues AND PRs. 1 item = 1 background Agent (sisyphus-junior). Issues: answer questions from codebase, analyze bugs, assess features. PRs: review changes, assess merge safety. All parallel, all background. Triggers: 'triage', 'triage issues', 'triage PRs', 'github triage'."
model: sonnet
argument-hint: "[repo] [--issues-only | --prs-only]"
effort: medium
---

# GitHub Triage — Unified Issue & PR Processor

## Tool Restrictions

This is a read-only analysis skill. DO NOT use:
- **Write** / **Edit** — Do not modify any files; report findings only

MCP tools available: `notepad_write` (record findings), `evidence_log` (after verification), `ast_search` (structural code search).

You are a GitHub triage orchestrator. Fetch all open issues and PRs, classify each one, then spawn exactly 1 background sisyphus-junior subagent per item. Each subagent analyzes its item, produces a report, and writes it to `/tmp/{datetime}/`. Never take destructive action on GitHub items.

---

## Zero-Action Policy (NON-NEGOTIABLE)

**NEVER run any GitHub mutation command.** This skill is read-and-report ONLY.

Forbidden commands (automatic failure if used):
- `gh pr merge` — NEVER
- `gh pr close` — NEVER
- `gh issue close` — NEVER
- `gh issue edit` — NEVER
- `gh pr edit` — NEVER
- `gh pr review --approve` — NEVER
- Any `gh` command that writes, modifies, or deletes

Allowed read-only commands:
- `gh issue list`, `gh issue view`
- `gh pr list`, `gh pr view`
- `gh api repos/{REPO}/pulls/{number}/files`
- `gh repo view`

Violation of Zero-Action Policy = CRITICAL FAILURE. Report findings only; let humans decide.

---

## Evidence Rule (MANDATORY for ALL claims)

Every factual claim in a report MUST be backed by a permalink with a commit SHA or file path.

Format:
```
CLAIM: "The handler for X is in Y"
EVIDENCE: https://github.com/{REPO}/blob/{COMMIT_SHA}/path/to/file.py#L42
```

If you cannot provide a permalink, you CANNOT make the claim. Write "UNVERIFIED" instead.

This applies to:
- Bug root cause identification (must cite exact file + line)
- "Feature already exists" claims (must cite where)
- "Fix is correct" assessments (must cite what it fixes)
- Any code reference in any report

---

## ARCHITECTURE

```
1 issue or PR  =  1 Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", run_in_background=true)
```

| Rule | Value |
|------|-------|
| Agent type for ALL items | `oh-my-claudeagent:sisyphus-junior` |
| Execution mode | `run_in_background=true` |
| Parallelism | ALL items launched simultaneously |
| Result storage | Each subagent writes to `/tmp/{datetime}/{number}-{type}.md` |
| Final collection | Orchestrator reads all reports and writes `SUMMARY.md` |

---

## PHASE 1: SETUP OUTPUT DIRECTORY

```bash
DATETIME=$(date +%Y%m%d-%H%M%S)
OUTDIR="/tmp/github-triage-${DATETIME}"
mkdir -p "${OUTDIR}"
echo "Reports will be written to: ${OUTDIR}"
```

---

## PHASE 2: FETCH ALL OPEN ITEMS

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# Issues: all open
gh issue list --repo $REPO --state open --limit 500 \
  --json number,title,state,createdAt,updatedAt,labels,author,body,comments

# PRs: all open
gh pr list --repo $REPO --state open --limit 500 \
  --json number,title,state,createdAt,updatedAt,labels,author,body,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup
```

If either returns exactly 500 results, paginate using `--search "created:<LAST_CREATED_AT"` until exhausted.

---

## PHASE 3: CLASSIFY EACH ITEM

For each item, determine its type based on title, labels, and body content:

### Issues

| Type | Detection |
|------|-----------|
| `ISSUE_QUESTION` | Title contains `[Question]`, `[Discussion]`, `?`, or body asks "how to" / "why does" / "is it possible" |
| `ISSUE_BUG` | Title contains `[Bug]`, `Bug:`, body describes unexpected behavior, error messages, stack traces |
| `ISSUE_FEATURE` | Title contains `[Feature]`, `[RFE]`, `[Enhancement]`, `Feature Request`, `Proposal` |
| `ISSUE_OTHER` | Anything else |

### PRs

| Type | Detection |
|------|-----------|
| `PR_BUGFIX` | Title starts with `fix`, `fix:`, `fix(`, branch contains `fix/` or `bugfix/`, or labels include `bug` |
| `PR_OTHER` | Everything else (feat, refactor, docs, chore, etc.) |

---

## PHASE 4: SPAWN 1 BACKGROUND AGENT PER ITEM

For EVERY classified item, spawn one sisyphus-junior agent:

```python
Agent(
    subagent_type="oh-my-claudeagent:sisyphus-junior",
    run_in_background=True,
    prompt=SUBAGENT_PROMPT_FOR_TYPE
)
```

Launch agents in batches of up to 5 concurrent. Wait for batch to complete before launching next batch.

---

## SUBAGENT PROMPT TEMPLATES

### SUBAGENT_ISSUE_QUESTION

```
You are analyzing GitHub issue #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands (no gh issue close, no gh issue comment, no gh pr merge). REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Body: {body}
- Comments: {comments_summary}

YOUR JOB:
1. Read the issue. Understand what the user is asking.
2. Search the codebase with Grep and Read to find the answer.
3. Find specific file paths and code that address the question.

EVIDENCE RULE: Every claim must cite a specific file path and line. If you cannot cite evidence, mark the claim UNVERIFIED.

Write your report to: {OUTDIR}/{number}-ISSUE_QUESTION.md

Report format:
# Issue #{number}: {title}
**Type:** ISSUE_QUESTION
**Status:** ANSWERED | PARTIAL | UNANSWERABLE

## Analysis
[Your findings with evidence]

## Evidence
[File paths and code references for each claim]
EVIDENCE: <file_path>:<line_number> — [description]

## Recommended Response
[Draft response text for a maintainer to post — do NOT post it yourself]

## Action Required
[What a human maintainer should do]
```

---

### SUBAGENT_ISSUE_BUG

```
You are analyzing GitHub issue #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands (no gh issue close, no gh issue comment, no gh pr merge). REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Body: {body}
- Comments: {comments_summary}

YOUR JOB:
1. Read the issue. Identify expected vs actual behavior and reproduction steps.
2. Search the codebase for the relevant code path.
3. Determine: confirmed bug, not a bug (behavior is correct), or unclear.

EVIDENCE RULE: For CONFIRMED_BUG, you MUST cite exact file + line. No citation = UNVERIFIED. For NOT_A_BUG, you MUST cite the code that proves correct behavior.

Write your report to: {OUTDIR}/{number}-ISSUE_BUG.md

Report format:
# Issue #{number}: {title}
**Type:** ISSUE_BUG
**Verdict:** CONFIRMED_BUG | NOT_A_BUG | NEEDS_INVESTIGATION

## Root Cause (if CONFIRMED_BUG)
EVIDENCE: <file_path>:<line_number> — [what goes wrong and why]

## Proof of Correct Behavior (if NOT_A_BUG)
EVIDENCE: <file_path>:<line_number> — [code that shows intended behavior]

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

ZERO-ACTION POLICY: Do NOT run any mutation commands. REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Body: {body}
- Comments: {comments_summary}

YOUR JOB:
1. Read the feature request.
2. Search the codebase to check if this feature already exists (partially or fully).
3. Assess implementation feasibility.

EVIDENCE RULE: If you claim the feature exists, cite the exact file and function.

Write your report to: {OUTDIR}/{number}-ISSUE_FEATURE.md

Report format:
# Issue #{number}: {title}
**Type:** ISSUE_FEATURE
**Already Exists:** YES_FULLY | YES_PARTIALLY | NO

## Existence Evidence (if exists)
EVIDENCE: <file_path>:<line_number> — [how the feature is implemented]

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

ZERO-ACTION POLICY: Do NOT run any mutation commands. REPORT ONLY.

ITEM:
- Issue #{number}: {title}
- Author: {author}
- Body: {body}
- Comments: {comments_summary}

YOUR JOB:
1. Read the issue. Understand what the reporter is describing.
2. Search the codebase with Grep and Read to gather relevant context.
3. Determine the best classification and whether it needs maintainer attention.

EVIDENCE RULE: Every factual claim must cite a specific file path and line. If you cannot cite evidence, mark the claim UNVERIFIED.

Write your report to: {OUTDIR}/{number}-ISSUE_OTHER.md

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
EVIDENCE: <file_path>:<line_number> — [description]

**Suggested Label:** [if any]
**Action Required:** [what a maintainer should do]
```

---

### SUBAGENT_PR_BUGFIX

```
You are analyzing GitHub PR #{number} for repository {REPO}.

ZERO-ACTION POLICY: Do NOT run any mutation commands (no gh pr merge, no gh pr close, no gh pr review --approve). REPORT ONLY. Read-only analysis via gh CLI and API only.

ITEM:
- PR #{number}: {title}
- Author: {author}
- Base: {baseRefName} <- Head: {headRefName}
- Draft: {isDraft}
- Mergeable: {mergeable}
- Review Decision: {reviewDecision}
- CI Status: {statusCheckRollup_summary}

YOUR JOB (READ-ONLY — no git checkout, no git fetch):
1. Fetch PR details: gh pr view {number} --repo {REPO} --json files,reviews,comments,statusCheckRollup,reviewDecision
2. Read changed files via: gh api repos/{REPO}/pulls/{number}/files
3. Search codebase to understand what the PR is fixing.
4. Assess merge safety against ALL six conditions.

MERGE CONDITIONS (report on each):
  a. CI status: ALL passing
  b. Review decision: APPROVED
  c. Fix is clearly correct — addresses an obvious, unambiguous bug
  d. No risky side effects (no architectural changes, no breaking changes)
  e. Not a draft PR
  f. Mergeable state is clean (no conflicts)

EVIDENCE RULE: For "fix is correct" assessment, cite the original bug code and the fix code with file paths.

Write your report to: {OUTDIR}/{number}-PR_BUGFIX.md

Report format:
# PR #{number}: {title}
**Type:** PR_BUGFIX
**Merge Safe:** YES (all 6 conditions met) | NO (list failing conditions)

## Fix Analysis
EVIDENCE: Original bug at <file_path>:<line_number>
EVIDENCE: Fix applied at <file_path>:<line_number> in PR diff

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

ZERO-ACTION POLICY: Do NOT run any mutation commands. READ-ONLY analysis only. No git checkout.

ITEM:
- PR #{number}: {title}
- Author: {author}
- Base: {baseRefName} <- Head: {headRefName}
- Draft: {isDraft}
- Mergeable: {mergeable}
- Review Decision: {reviewDecision}
- CI Status: {statusCheckRollup_summary}

YOUR JOB:
1. Fetch PR details: gh pr view {number} --repo {REPO} --json files,reviews,comments,statusCheckRollup
2. Read changed files via: gh api repos/{REPO}/pulls/{number}/files
3. Assess the PR.

Write your report to: {OUTDIR}/{number}-PR_OTHER.md

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
| Running any gh mutation command (merge, close, edit) | CRITICAL |
| Making claims without Evidence Rule citations | CRITICAL |
| Batching multiple items into one Agent call | CRITICAL |
| Using `run_in_background=false` | HIGH |
| Spawning any agent type other than sisyphus-junior | HIGH |
| Checking out PR branches via git | CRITICAL |
| Not writing report to /tmp/{datetime}/ directory | HIGH |
| Claiming feature exists without file:line citation | HIGH |

---

## QUICK START

When invoked:

1. Create output directory: `/tmp/github-triage-{datetime}/`
2. Fetch all open issues + PRs via gh CLI (paginate if 500 reached)
3. Classify each item (ISSUE_QUESTION, ISSUE_BUG, ISSUE_FEATURE, ISSUE_OTHER, PR_BUGFIX, PR_OTHER)
4. For EACH item: `Agent(subagent_type="oh-my-claudeagent:sisyphus-junior", run_in_background=True, prompt=...)`
5. Launch ALL agents in a single response — maximum parallelism
6. Collect reports from output directory once agents complete
7. Write `{OUTDIR}/SUMMARY.md` with aggregated findings
8. Report the output directory path to the user
