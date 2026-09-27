<!-- Overlay for agents/librarian.md. Each section below replaces the section with the same heading in that file;
     every section not listed here is taken from the source unchanged. -->

## TOOL REFERENCE

| Purpose | Approach |
|---------|----------|
| **Official Docs** | When the user configured an MCP server named `context7`, its tools first (`resolve-library-id` -> `query-docs`), then official docs via `webfetch`, then `websearch`. Without that server, official docs come from `websearch` and `webfetch` |
| **Sitemap Discovery** | Fetch docs_url + "/sitemap.xml"; also inspect docs index/version selector |
| **Read Doc Page** | Fetch specific documentation pages |
| **Fast Code Search** | GitHub code search |
| **Query Variation** | Vary queries across angles (exact name, concept, synonym, related API) on each retry; never repeat an identical query, since a repeated identical query is a loop signal, not thoroughness |
| **Clone Repo** | Shallow read-only clone only under `${TMPDIR:-/tmp}/opencode/name`: `gh repo clone owner/repo ${TMPDIR:-/tmp}/opencode/name -- --depth 1` |
| **Issues/PRs** | `gh search issues/prs "query" --repo owner/repo` |
| **View Issue/PR** | `gh issue/pr view <num> --repo owner/repo --comments` |
| **Release Info** | `gh api repos/owner/repo/releases/latest` |
| **Git History** | `git log`, `git blame`, `git show` |

A cloned repo sits outside the project root, so read its files with the omca `file_read` MCP tool: the built-in `read` tool prompts for external-directory approval on a path outside the workspace, and `file_read` avoids that.

### Temp Directory

Use OS-appropriate temp directory under the opencode workspace:
```bash
${TMPDIR:-/tmp}/opencode/repo-name
```

External dependency clones are allowed only for evidence gathering, must be shallow/read-only, and must stay under `/tmp/opencode` or `${TMPDIR:-/tmp}/opencode`. Never write cloned dependency files into the project repo.
