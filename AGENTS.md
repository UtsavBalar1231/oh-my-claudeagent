# Repository Inventory

This repository's inventory is defined by on-disk files — query with `find`, `ls`, or `jq` against the source directory at read time rather than relying on a maintained count.

## Agent inventory

Agent definitions live in `agents/*.md`:

`executor`, `explore`, `hephaestus`, `librarian`, `metis`, `momus`, `multimodal-looker`, `oracle`, `prometheus`, `sisyphus`

## Skill inventory

Skills live in `skills/*/SKILL.md`:

`consolidate-memory`, `dev-browser`, `frontend-ui-ux`, `git-master`, `github-triage`, `handoff`, `hephaestus`, `init-deep`, `metis`, `momus`, `omca-setup`, `playwright`, `refactor`

## Command inventory

Slash commands live in `commands/*.md` (user-invocable, depth-0 orchestration entrypoints):

`plan`, `start-work`

## Runtime notes

- Hook events live in `hooks/hooks.json`; top-level shell scripts in `scripts/*.sh`; MCP entries in `.mcp.json`.
- `UserPromptSubmit` routes to `keyword-detector.sh` for handoff, stop-continuation, and other activation keywords.
- The docs follow the hard cutover model: slash-first workflows, native plan and memory ownership, managed settings as the policy boundary.
