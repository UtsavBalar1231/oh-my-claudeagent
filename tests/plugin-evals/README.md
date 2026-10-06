# Plugin evals

Cases for `claude plugin eval` in two groups: the health gate shared by the planning skills, and `context/`, the behaviors OMCA's always-on prompt text is there to produce.

## Health gate

Each case runs the skill's slash command against a mocked `omca` server whose `health_check` reports a runtime that is not `ok`, then checks that the skill called `health_check`, pointed at `/oh-my-claudeagent:omca-setup`, and delegated nothing:

- `plan-stops-on-degraded-runtime` for `/oh-my-claudeagent:plan`
- `start-work-stops-on-degraded-runtime` for `/oh-my-claudeagent:start-work`

Both skills set `disable-model-invocation`, so each prompt is the slash command and there is no `tool_used: Skill` grader. A mock file at `mocks/omca/health_check.md` in each case supplies the tool result.

These cases grade the gate only. Interviewing, plan writing, the reviewer loop and plan selection need `AskUserQuestion` (absent in a `-p` run), subagents, the plans directory and a plan file the run can locate (`context.add_dirs` gives the model no path), so they are not covered.

## Context

Each case seeds a small bun project in a git repository with `fixture.sh` and grades tool calls, so no judge model runs. Run them before and after any change to the agent bodies, the output style, the first-prompt guidance, the server instructions or a description, and accept the change only when no grader's pass count drops:

- `evidence-after-tests`: after `bun test`, the model calls `evidence_log`.
- `direct-lookup-no-delegation`: a lookup two searches answer spawns no subagent.
- `read-tool-for-files`: a file is read with Read, never `cat`, `head`, `tail` or `sed`.
- `executor-report-shape`: a delegated executor reports with its `STATUS:` and `SLOP PASS:` lines.
- `wide-survey-fans-out`: a survey of three independent areas goes to parallel explorer agents. Its outcome varies run to run, so give it five runs. It is the case that moves when always-on prose changes. Measured on 2026-10-06 with Opus 5.5 and an exact grader (checked against the mock model first), commit `c19853a` sent the three-area survey to OMCA's search agent in 1 of 5 runs, while the other four context cases passed 3 of 3. The earlier higher counts came from a grader that matched the search agent's old name anywhere in the Agent input.

They start the real `omca` server, since a mocked tool carries a placeholder description, so they need `--mocks off`, grants for Bash, Edit and the omca tools, and `--scaffold`.

## Running

A real run calls a model and costs money. Run it only with the maintainer's approval of the estimate.

The dev checkout holds hard links (`node_modules`), and `claude plugin eval` refuses a plugin tree that has any. Run against a packaged copy, which leaves `tests/` out, so copy the cases in:

```bash
dest=$(mktemp -d)
bun scripts/package.ts "$dest"
cp -r tests/plugin-evals "$dest/tests/plugin-evals"
cd "$dest"
claude plugin eval . --eval-dir tests/plugin-evals --case '*-stops-on-degraded-runtime' \
  --ablation none --runs 1 --no-publish --output-dir "$dest/out"
claude plugin eval . --eval-dir tests/plugin-evals/context --ablation none --runs 3 \
  --mocks off --scaffold --allow-tools Bash Edit "mcp__plugin_oh-my-claudeagent_omca__*" \
  --no-publish --output-dir "$dest/out-context"
```

To compare two trees, package each into its own directory and run the context command in both.

`--ablation none` matters: without the plugin the slash commands do not exist, so the baseline arm scores 0 and the delta says nothing. The default of three runs per case triples the cost.

To check that the cases load and the graders work without a model call, point `ANTHROPIC_BASE_URL` at `scripts/qa/mock-model.ts` (as `scripts/qa/lib.ts` does for `runClaude`) with `ANTHROPIC_AUTH_TOKEN` set to any value and a scripted reply.
