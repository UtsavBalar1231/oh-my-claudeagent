# Plugin comparison harness

Comparison of OMCA with similar Claude Code plugins, in two phases.

The hermetic phase measures what a plugin costs and does before the model says anything useful: installed size, tokens added to each request, startup, per-tool-call time, files written, guard behaviour and stop-gate behaviour. Every model request goes to a local mock, no container has network egress, and no Anthropic credential exists anywhere in the run.

The eval phase asks whether a plugin changes what Claude does on real tasks. It runs on a Claude Max subscription, in batches, with a credential, and is described in `EVAL.md`. It starts only when you pass `--real` and confirm the printed plan.

## Run it

```bash
bun benchmarks/compare/run.ts build            # the two images
bun benchmarks/compare/run.ts all --rounds 20  # prepare, install, online, first-run, timing, toolsearch, guards, stop, nobun, report
bun benchmarks/compare/run.ts report           # regenerate results/<date>.{json,md} from the stored runs
bun benchmarks/compare/run.ts eval             # print the eval plan and start nothing
bun benchmarks/compare/run.ts eval --rehearse  # run the eval pipeline against the mock model, with no credential
```

Individual stages (`prepare`, `install`, `online`, `first-run`, `timing`, `toolsearch`, `keywords`, `guards`, `stop`, `nobun`) take `--arm <id>` (repeatable), `--rounds <n>`, `--date <YYYY-MM-DD>` and `--keep-raw`. Per-stage data is stored under `~/.cache/omca-compare/runs/<date>/`; the timing stage resumes where it stopped. The hermetic stages are measured with the Claude Code version in `arms.json`; `build` pins the image to it. Needs Docker and bun on the host. Third-party plugin code runs only inside the containers; the host only clones repositories and exports files with git.

Run the specs for the parts that need no Docker with `bun test benchmarks/compare`.

## Files

| File | Role |
| --- | --- |
| `Dockerfile` | Ubuntu 24.04, node 22.23.3, bun 1.4.2, TypeScript 7.0.2 (for the eval fixture), git, strace, jq, python3, and Claude Code from the official installer pinned to the version in `arms.json`, with `DISABLE_AUTOUPDATER=1`. A second copy of bun at `/opt/driver/bun` runs the entrypoint. |
| `Dockerfile.ruflo-seed` | Adds `ruflo@3.51.1` from npm so ruflo's `npx` fallback is never needed. |
| `arms.json` | The Claude Code version, the internal network, and each arm's source, pinned commit, install ids and pre-seeding. `inEval: false` keeps an arm out of the eval. |
| `run.ts`, `harness.ts`, `scenarios.ts`, `analyze.ts`, `report.ts` | Driver, docker and proxy plumbing, scripted sessions, request-body analysis and statistics, report rendering. |
| `session.ts` | Container entrypoint, run with bun. Modes `install` and `session` serve the hermetic stages; `eval` and `grade` serve the eval. |
| `eval.ts`, `cases.ts`, `transcript.ts`, `eval-fixture.ts`, `reference.ts` | Eval driver (plan, confirmation, batches, resume, report), the cases with their deterministic graders, the stream-json parser, fixture assembly, and the reference solutions used to rehearse and to test the fixture. |
| `credential.ts`, `egress.ts` | Token file checks and redaction; the allowlist proxy that limits container egress. |
| `cost.ts` | Usage-load estimate for the eval from the measured per-request overhead. |
| `*.spec.ts` | Specs for the pure parts: statistics, report and cost rendering, graders, the token checks, the proxy, the eval gating. |
| `fixtures/project/` | The git project every hermetic session runs in. |
| `fixtures/eval/` | The eval project, per-case overlays and hidden suites. A file ending in `.fixture` loses that suffix when the project is assembled, so test files do not look like repository tests. |
| `EVAL.md` | The eval phase: cases, graders, credential and egress handling, batches, and the usage-load estimate. |
| `results/<date>.json`, `results/<date>.md` | Aggregated results; `results/<date>-raw/` holds the first and last request body of each arm and session from the first paired round. |

## Method

**Arms.** Each third-party repository is cloned on the host into `~/.cache/omca-compare/repos/`, exported at its pinned commit with `git read-tree` and `git checkout-index` (no `.git`, no export attributes), and mounted read-only into the container as a directory-source marketplace. `claude plugin marketplace add <dir>` then `claude plugin install <id>` run inside a container. OMCA is this repository's HEAD at prepare time, exported and filtered with `scripts/package.ts` (the same exclusions as a release), with `.claude-plugin/marketplace.json` rewritten so the plugin source is `./` instead of the pinned GitHub sha. Uncommitted working-tree changes are not included. The commit is recorded in the results.

The superpowers marketplace repository has no commit that pins 6.4.2 (its HEAD pins 6.3.0 with an unpinned git URL source), so that arm is a generated marketplace with the same name and a plugin directory taken from the `v6.4.2` tag commit of obra/superpowers. ruflo runs twice: with no pre-seeding, which records the offline failure of its `npx` fallback, and with `ruflo@3.51.1` installed globally in the image.

**Sessions.** The template config dir produced by each install is copied into a fresh `CLAUDE_CONFIG_DIR` inside every session container, and a fresh fixture git project (with a bare remote, a dirty tracked file, a staged file, a `build/` directory) is created. `claude -p` runs with `--permission-mode bypassPermissions` against a mock model reached through the host proxy on the internal network. Four scripted sessions: (a) one plain prompt; (b) twenty Bash calls (`true`); (c) ten Read calls; (d) a prompt containing `plan this`.

**Mock and proxy.** `scripts/qa/mock-model.ts` serves the scripted turns on the host's loopback. It binds `127.0.0.1` only and its access log carries no bodies, so a recording proxy in `harness.ts` listens on the Docker network's gateway address, stores every `/v1/messages` body and forwards it to the mock. Containers use `--add-host=host.docker.internal:172.31.77.1` (the gateway of the internal network) instead of `host-gateway`, because `host-gateway` resolves to the docker0 address, which an internal network cannot reach.

**Network.** The `omca-compare-net` network is created with `--internal`, so containers reach only the proxy: no DNS, no egress. Plugin code that tries to fetch something fails, and `strace -e trace=connect,sendto,sendmmsg,sendmsg` shows what it tried (DNS names are decoded from the query packets). The only exception is the labelled online install probe, which repeats an install on the default bridge for arms whose offline install tried the npm registry, to see what Claude Code fetches. It carries no credentials.

**Tool search.** Claude Code turns MCP tool search off when `ANTHROPIC_BASE_URL` is not a first-party host, so the main sessions ship every MCP tool schema in the `tools` array on every request. Against the first-party API, MCP tools are deferred and only their names are listed, except for servers that declare `alwaysLoad`. The `toolsearch` stage repeats session (a) with `ENABLE_TOOL_SEARCH=true` (three rounds) so the report shows both shapes; the tool-search table is the closer match to real traffic.

**Interleaving and statistics.** One warm-up round is discarded. In each round, for each of the four sessions, the arms run back to back in an order rotated by one position per round, so no arm always runs first or after a particular neighbour. Medians come with the 25th to 75th percentile, the 95th percentile (nearest rank: the 19th of 20 runs) and n. Deltas against baseline are paired by round.

**Tokens.** Estimated as `ceil(characters / 4)` over the recorded request bodies, identically for every arm. Claude's tokenizer is not available offline, and Claude 4.7 and later tokenizers produce about 30 percent more tokens than earlier ones for the same text, so absolute values are approximate and ratios between arms are the usable part. Components are separated by `system` versus `tools` (names starting `mcp__` are MCP tools) versus message text cut at known section markers.

**Timing.** Process start is stamped inside the container just before `claude` runs; request arrival is stamped by the host proxy. Both use the same kernel clock. Per-call time is first to last request of session (b) divided by 20, which excludes startup and shutdown.

**Guards and stop gate.** The mock issues the same Bash call twice per session, so a gate that asks for facts and lets the retry through (ECC's) shows as "gated once, ran on retry" instead of "blocked". The offline ruflo arm gets one call, because every Bash call there blocks about 90 s on `npx`. Whether the command ran is decided from its effect (a sentinel file, a reverted file, the remote's `main`, a new commit), not from what the plugin says; the denial text names the blocker. For the stop gate the mock writes a plan with unchecked tasks and ends the turn; for OMCA it first binds the session to the plan through `boulder_write`. A continuation counts only when a main-thread request (same system prompt as the first) follows the scripted `done` reply; hook-made model calls, such as claude-code-harness's agent hooks, do not.

**No-bun probe.** The `nobun` stage repeats the OMCA arm with `/usr/local/bin/bun` bind-mounted from `/dev/null`, to show what the plugin loses without its runtime. The entrypoint runs on the other copy of bun, so the probe leaves it working.

## Limits

- Token deltas depend on Claude Code's request shape at the version in `arms.json`, which includes the model-visible text of built-in tools and skills. The numbers move with the client version and with the model's tokenizer. The stored 2026-10-03 results were measured on 2.1.287, before the image moved to 2.1.288 and gained TypeScript.
- Mock responses are trivial. Real sessions add model-chosen tool calls, subagents, skill loads and long outputs; per-session plugin behaviour (workflows, skills invoked, extra turns) is not exercised, only fixed overheads and the hooks that fire on every session, prompt and tool call.
- `claude -p` has one prompt, so per-prompt hooks fire once. Per-prompt injection is measured as session (d) against (a), which only exposes keyword-driven injection.
- `bypassPermissions` means a guard registered only on `PermissionRequest` does not fire. A guard that is conditional on interactive state (a TTY, an auto-mode classifier) is not exercised.
- Stop gates other than OMCA's are not armed with their own state; a `stopped` result for another arm means no stop was blocked in a clean state.
- One machine, one image. Container start cost is common to all arms; only differences are meaningful. The host was not idle (other work ran on it), which widens the spreads.
- OMCA is measured as packaged at HEAD without `omca-setup` having edited `~/.claude/settings.json` or `CLAUDE.md`, and with its `userConfig` options unset (defaults). Its `.mcp.json` runs `bun`, so bun is a hard runtime requirement of the plugin; the image provides it.
- Dates, versions and models inside request bodies reflect the container, not production.
- No arm was run with its optional MCP servers connected to real services, and arms that bundle remote MCP servers (OMCA's `context7` and `grep`) fail to connect in a closed network; the failed connection attempt is part of what is measured.
