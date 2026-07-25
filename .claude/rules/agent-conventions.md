---
globs: agents/*.md
description: Agent frontmatter conventions for oh-my-claudeagent plugin agents
---

When editing or creating agent definitions:

- **Use `disallowedTools:`** never `tools:`, with no exceptions. `tools:` is a strict allowlist that blocks MCP tool inheritance, and an incomplete list launches the agent with zero usable tools. Every shipped agent, including the deliberately narrow multimodal-looker, expresses its restrictions as `disallowedTools:`. `validate-plugin.sh` fails on any `tools:` key in agent frontmatter.
- **`name:` must not contain `:`** — the platform rejects an agent whose frontmatter `name` holds a colon, so the agent never loads. Use lowercase-kebab names (`multimodal-looker`). The plugin namespace prefix used at call sites (`oh-my-claudeagent:executor`) is added by the platform and is never part of the `name:` value. `validate-plugin.sh` fails on a colon in `name:`.
- **Model field**: declare a tier alias — `opus`, `sonnet`, or `fable` — which is what every OMCA agent does, so an agent tracks whatever the platform's current model is for that tier and the frontmatter can never go stale. Full IDs (`claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`) still work and remain valid as a per-invocation `Agent(..., model=...)` override, but do not put one in frontmatter: a pinned ID is a recurring maintenance surface that has to be swept across every agent file each time a generation ships. Other aliases: `opusplan` uses Opus in plan mode and Sonnet for execution; `best` resolves to the most capable available model. Haiku is off the default roster (outdated) but remains a supported override model — `Agent(..., model="haiku")` still works; just don't assign it as an agent's default `model:`.

  Two tradeoffs come with the alias, both accepted:
  - **Display**: an alias in frontmatter yields a generation-less label (`Opus`, not `Opus 5`) in the state file the SubagentStart hook writes. Subagent statusline rows are unaffected in practice, because `_resolve_model` in `statusline/subagent.py` prefers the task payload's own `model` field, which carries the resolved generation, and only falls back to the frontmatter-derived label when the payload omits it (older platforms).
  - **Third-party providers**: aliases resolve per provider, so on some of them a tier lands on an older generation than on the Anthropic API. `sonnet` resolves to Sonnet 4.6 on Claude Platform on AWS and Sonnet 4.5 on Amazon Bedrock, Google Cloud's Agent Platform, and Microsoft Foundry; `opus` resolves to Opus 4.6 on Microsoft Foundry. This applies to the planners (`opus`) and the advisor (`fable`) exactly as it already did to the `sonnet` workers. Users who need a specific generation on such a provider set it in their own settings (`ANTHROPIC_DEFAULT_OPUS_MODEL` and siblings, which take a full provider model ID, never an alias) rather than in plugin agent frontmatter.

  A frontmatter-declared tier means the Agent tool call carries no `model` parameter at all, so `Agent(model:opus)`-style permission rules cannot gate it. Only an explicit per-call `model=` can be gated that way.
- **Required frontmatter**: name, description, model. Add `disallowedTools:` when restricting capabilities.
- **No `permissionMode:`** — this field is stripped from plugin agents by Claude Code for security. Do not declare it. Plugin agents inherit the parent session's permission context.
- **`memory: project`** enables Claude-native project memory. Not a plugin surface.
- **`## Memory Guidance` body section**: agents with `memory: project` declare role-specific save triggers in a `## Memory Guidance` body section. Include at least 2 role-specific negative examples. Do NOT restate the platform-injected protocol (typed categories, `MEMORY.md` format, write mechanics) — the platform auto-injects those when `memory:` is set.
- **Optional display/behavior fields**: `color` (red, blue, green, yellow, purple, orange, pink, cyan) for task list differentiation, `background: true` to always run as background task, `isolation: worktree` to run in isolated git worktree.
- **Scaffold**: `just new-agent NAME` creates boilerplate. Update description, model, and disallowedTools after.
- **No `initialPrompt:` in plugin agents** — this field only fires for main session agents (via `claude --agent`). Plugin agents are invoked as subagents where `initialPrompt` has no effect.
- After adding an agent, update `templates/claudemd.md`'s agent catalog table and the color
  table below, and add a row wherever README.md enumerates agents. Do not add a count anywhere:
  docs enumerate the roster, they never assert how many there are.

When editing or creating skill definitions (`skills/*/SKILL.md`):

- **Skill description cap**: 1,536 characters hard limit (v2.1.105+). Internal soft cap is ≤512 characters — keep descriptions concise to avoid truncation in reduced-context windows. Run `validate-plugin.sh` (warns at 512, fails at 1,536).

### Agent color map (v2.2.0+)

<!-- v2.1.140 palette re-verified 2026-05-13 against https://code.claude.com/docs/en/sub-agents: matches current 8-color set (red/blue/green/yellow/purple/orange/pink/cyan). See .omca/notes/agent-color-palette-v140.md for the captured quote. -->

Platform supports 8 colors: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`.
OMCA ships more agents than the palette has colors, so two colors are shared between agents
that rarely run concurrently. The table below is the authority on which; `ls agents/` is the
authority on the roster.

| Agent | Color | Role / Rationale |
|---|---|---|
| sisyphus | purple | Orchestrator — royal/deep-think |
| prometheus | cyan | Planner — cool/communicative |
| metis | yellow | Pre-plan gap analysis — analytical |
| momus | red | Plan critic — alert/error |
| executor | green | Implementation — build/ship |
| explore | blue | Local search — ocean/depth |
| librarian | orange | External research — warm/discovery |
| oracle | purple | Deep advisor — shares with sisyphus (oracle never orchestrates; sisyphus never advises in same turn) |
| hephaestus | yellow | Build fixer — shares with metis (hephaestus is fix-time; metis is plan-time) |
| multimodal-looker | pink | Visual analyst — unique |

Update this table if a sharing pair causes actual UX confusion in task lists.

### `subagent_type` matching (v2.1.140+)

The Agent tool matches `subagent_type` case- and separator-insensitively. `"Code Reviewer"`, `"code-reviewer"`, `"code_reviewer"`, and `"CodeReviewer"` all resolve to the canonical `code-reviewer` agent.

**OMCA delegation continues to use the canonical lowercase-kebab form** (`oh-my-claudeagent:executor`, not `Oh My ClaudeAgent: Executor`). The case-insensitive matching is forgiveness for end-user typos, not a license to invent variants. All OMCA agent docs, skill prompts, and orchestration examples use the canonical form; new content must too.
