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
| **Clone Repo** | Shallow read-only clone only under `.omca/scratch/librarian-<datetime>/name` in the project root: `gh repo clone owner/repo .omca/scratch/librarian-<datetime>/name -- --depth 1` |
| **Issues/PRs** | `gh search issues/prs "query" --repo owner/repo` |
| **View Issue/PR** | `gh issue/pr view <num> --repo owner/repo --comments` |
| **Release Info** | `gh api repos/owner/repo/releases/latest` |
| **Git History** | `git log`, `git blame`, `git show` |

A clone under `.omca/scratch/` sits inside the project root, so the `read` tool reads its files directly.

### Scratch Directory

Clone under the project's scratch directory, which is the same on every OS:
```text
.omca/scratch/librarian-<datetime>/repo-name
```

`<datetime>` is the current date and time as `YYYYMMDD-HHMMSS`; when the session context gives only the date, append a short word of your own so two runs on one day get different directories. `git clone` creates the missing parent directories, so no separate command is needed to make them. OMCA's server writes `.omca/.gitignore` when it starts, so clones stay out of commits.

External dependency clones are allowed only for evidence gathering, must be shallow/read-only, and must stay under `.omca/scratch/`. Never copy cloned dependency files into the tracked project tree.
