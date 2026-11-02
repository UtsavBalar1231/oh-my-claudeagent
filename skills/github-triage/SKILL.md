---
name: github-triage
description: "Use to triage open GitHub issues and PRs in parallel, read-only, one executor per item (\"triage issues\", \"review open PRs\")."
model: opus
argument-hint: "[repo] [--issues-only | --prs-only]"
effort: medium
disallowed-tools: [Edit]
---

# GitHub triage

Go through a repository's open issues and pull requests and tell the maintainer what each one needs. The maintainer makes every decision, so a triage run changes nothing on GitHub or in the repository. The only files it writes are reports under `.omca/scratch/github-triage-{datetime}/` in the project root.

## Read-only commands

Use `gh issue list`, `gh issue view`, `gh pr list`, `gh pr view`, `gh repo view` and `gh api --method GET`. Any command that merges, closes, edits, comments on, labels or reviews an item is out, as is `gh api` with a method that writes. Workers do not run `git checkout` or `git fetch`.

## Citations

A claim about code cites a GitHub permalink pinned to a commit SHA: `https://github.com/{REPO}/blob/{SHA}/path/to/file.py#L42`. A link through a branch name does not count, since the line it points at moves. A claim with no such link is marked UNVERIFIED.

## 1. Choose the output directory

Set `{OUTDIR}` to the absolute path `<project root>/.omca/scratch/github-triage-<datetime>`, with `<datetime>` as `YYYYMMDD-HHMMSS`. When the session gives only the date, add a short word of your own so two runs in one day stay apart. The Write tool creates the directory with the first report, and OMCA's server keeps `.omca/` out of commits. Tell the user the path now.

## 2. Fetch metadata

With no repo argument, `gh repo view --json nameWithOwner -q .nameWithOwner` gives `{REPO}`. Honor `--issues-only` and `--prs-only`.

```bash
gh issue list --repo {REPO} --json number,title,labels,author,createdAt,updatedAt,state --state open --limit 500
gh pr list --repo {REPO} --json number,title,labels,author,createdAt,updatedAt,state,baseRefName,headRefName,isDraft,mergeable,reviewDecision,statusCheckRollup --state open --limit 500
```

Leave bodies and comments for the workers, because control characters in them can break a large listing. A listing of exactly 500 means there may be more: continue with `--search "created:<LAST_CREATED_AT"` until one comes back short.

## 3. Classify from metadata

Use the title, labels, author and PR fields, without opening the item.

| Type | Signals |
|---|---|
| `ISSUE_BUG` | A bug label or `[Bug]` or `Bug:` in the title, or a title describing broken behavior, even one phrased as a question |
| `ISSUE_FEATURE` | An enhancement label, or `[Feature]`, `[RFE]`, `[Enhancement]`, `Feature Request` or `Proposal` in the title |
| `ISSUE_QUESTION` | A question or discussion label, or `[Question]` or `[Discussion]` in the title, with no defect reported |
| `ISSUE_OTHER` | None of those |
| `PR_BUGFIX` | A title starting with `fix`, a branch containing `fix/` or `bugfix/`, or a `bug` label |
| `PR_OTHER` | Any other pull request |

## 4. Bound the run

The session has no limit on total subagents, and batches of five stay under the concurrent one (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, 20 by default). What limits a run is time and this conversation's context, since each finished worker's result lands here. Choose how many items to take from the user's stated scope, or else from the size of the list against the context you have left.

When the list is longer than that, take the most recently updated items and write the rest to `{OUTDIR}/SKIPPED.md`, one line each with number, type, title and `updatedAt`. State both counts in `SUMMARY.md` and in your final message. A partial run is fine as long as it says it is partial.

## 5. Run one worker per item

Spawn `oh-my-claudeagent:executor` for each item, up to five in a message. Each result arrives in a task notification, usually in a later turn, or directly if the platform ran that worker in the foreground. Start the next batch, read reports or write the summary only once the current batch has reported. While a batch runs, do work that does not overlap it; with none left, end the turn once. Never send repeated holding messages, and never respawn an item because its result is still on the way.

Fill in this brief for each worker:

```text
Triage {issue or PR} #{number} of {REPO}: "{title}" by {author}.
{For a PR: {headRefName} into {baseRefName}, draft {isDraft}, mergeable {mergeable}, review {reviewDecision}, checks {summary of statusCheckRollup}.}

This is read-only. Run only gh view commands and `gh api --method GET`, plus local search and Read. No git checkout or git fetch. Change nothing on GitHub or in the repository, and write nothing except your report.

Get the details first.
Issue: gh issue view {number} --repo {REPO} --json body,comments
PR: gh pr view {number} --repo {REPO} --json body,files,reviews,comments,statusCheckRollup,reviewDecision
    and gh api --method GET repos/{REPO}/pulls/{number}/files

Search code with ast_search for syntax (a signature, a call site, an import) and rg for literal text, then Read what you find. Cite each claim about code with a permalink pinned to a commit SHA, or mark it UNVERIFIED.

{The "Find out" cell for this type}

Write {OUTDIR}/{issue or pr}-{number}.md:
# {Issue or PR} #{number}: {title}
**Type:** {type}
{The "Headline" cell for this type}
{The "Sections" cell for this type, each as a ## heading}
## Next step
What a maintainer should do. Draft any reply for them to post; never post it yourself.
```

| Type | Find out | Headline | Sections |
|---|---|---|---|
| `ISSUE_QUESTION` | What is being asked, and the answer from the code | **Status:** ANSWERED, PARTIAL or UNANSWERABLE | Findings, with citations. Draft reply |
| `ISSUE_BUG` | Expected and actual behavior, the steps to reproduce, and the code path. Decide whether the defect is real | **Verdict:** CONFIRMED_BUG, NOT_A_BUG or NEEDS_INVESTIGATION | Cause, or proof that the behavior is correct, cited to exact lines. For a real bug, the change needed. Severity with the reason |
| `ISSUE_FEATURE` | Whether it already exists in whole or in part, and how much work it would be | **Already exists:** FULLY, PARTLY or NO | Where it exists, cited to file and function. Effort: small, medium, large or redesign. Files a change would touch |
| `ISSUE_OTHER` | What it is really about, and whether a maintainer needs to look | **Best fit:** question, bug, feature, discussion, meta or stale. **Needs attention:** yes or no | Findings, with citations. Suggested label |
| `PR_BUGFIX` | What it fixes, and whether it is safe to merge. It is safe only if checks all pass, the review is approved, the fix is plainly right for a plain bug, nothing breaks or shifts architecture, it is not a draft, and it has no conflicts | **Merge safe:** YES, or NO with the conditions it fails | Each condition with its state. The bug and the fix, both cited. What could go wrong after merging |
| `PR_OTHER` | What it does, and how it fits the project | **Subtype:** feature, refactor, docs, chore, test or other. **Risk:** low, medium or high, with the reason | Summary in two or three sentences. Checks, review, conflicts and draft state. Whether it fits the project's direction, with evidence |

## 6. Summarize

Read every `issue-*.md` and `pr-*.md` report in `{OUTDIR}`, then write `{OUTDIR}/SUMMARY.md` with:

- the repository, the date, the directory, and how many items were triaged and skipped
- a table of issues (number, title, type, verdict, next step) and a table of pull requests (number, title, type, merge safe, next step)
- the items a maintainer should look at first, one line each
- counts of confirmed bugs, answerable questions, merge-safe pull requests and items waiting on a human decision

Give the user the directory path when you finish.
