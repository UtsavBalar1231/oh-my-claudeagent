# Plugin evals

Cases for `claude plugin eval` that grade the health gate shared by the planning skills. Each case runs the skill's slash command against a mocked `omca` server whose `health_check` reports a runtime that is not `ok`, then checks that the skill called `health_check`, pointed at `/oh-my-claudeagent:omca-setup`, and delegated nothing:

- `plan-stops-on-degraded-runtime` for `/oh-my-claudeagent:plan`
- `start-work-stops-on-degraded-runtime` for `/oh-my-claudeagent:start-work`

Both skills set `disable-model-invocation`, so each prompt is the slash command and there is no `tool_used: Skill` grader. A mock file at `mocks/omca/health_check.md` in each case supplies the tool result.

These cases grade the gate only. Interviewing, plan writing, the momus loop and plan selection need `AskUserQuestion` (absent in a `-p` run), subagents, the plans directory and a plan file the run can locate (`context.add_dirs` gives the model no path), so they are not covered.

## Running

A real run calls a model and costs money. Run it only with the maintainer's approval of the estimate.

The dev checkout holds hard links (`node_modules`), and `claude plugin eval` refuses a plugin tree that has any. Run against a packaged copy, which leaves `tests/` out, so copy the cases in:

```bash
dest=$(mktemp -d)
bun scripts/package.ts "$dest"
cp -r tests/plugin-evals "$dest/tests/plugin-evals"
cd "$dest"
claude plugin eval . --eval-dir tests/plugin-evals --ablation none --runs 1 \
  --no-publish --output-dir "$dest/out"
```

`--ablation none` matters: without the plugin the slash commands do not exist, so the baseline arm scores 0 and the delta says nothing. The default of three runs per case triples the cost.

To check that the cases load and the graders work without a model call, point `ANTHROPIC_BASE_URL` at `scripts/qa/mock-model.ts` (as `scripts/qa/lib.ts` does for `runClaude`) with `ANTHROPIC_AUTH_TOKEN` set to any value and a scripted reply.
