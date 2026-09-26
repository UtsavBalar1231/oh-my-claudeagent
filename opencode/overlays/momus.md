## Invocation

**Preferred**: run the `/omca-momus` command with the plan FILE PATH:
```
/omca-momus .opencode/plans/my-plan.md
```

**Direct spawn**: a caller that has the `subagent` tool can also spawn agent `omca-momus` with the plan path as the prompt:
```
subagent: agent=omca-momus, prompt=".opencode/plans/my-plan.md"
```

File path only. Not inline plans, todo lists, or text summaries.

**Input-path extraction rule**: extract a single plan path from anywhere in the input (e.g. `.opencode/plans/my-plan.md`, `.omca/plans/my-plan.md`), ignoring wrappers and system noise around it. Exactly one plan path found → valid input, read it. Zero or multiple plan paths found → do not guess which path was intended; return the Final Verdict Format REJECT with Confidence: HIGH and a Justification naming the input problem ("no plan path found in input" or "multiple plan paths found, ambiguous target").
