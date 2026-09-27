<!-- Overlay for skills/git-master/SKILL.md. Each section below replaces the section with the same heading in that file;
     every section not listed here is taken from the source unchanged. -->

## Tool Restrictions

All changes via git in `shell`. No `edit`/`write` (direct file modification) or `subagent` (delegation).

MCP tools: `omca_evidence_log` (verification), `omca_ast_search` (code archaeology).

Three specializations: Commit Architect (atomic commits, style detection), Rebase Surgeon (history rewriting, conflicts), History Archaeologist (when and where changes were introduced).

## Non-Interactive Environment

The `shell` tool cannot answer an editor or a credential prompt, so a git command that can open one needs it disabled. Prefix these commands: `git commit` without `-m`, `git rebase` (including `-i --autosquash` and `--continue`), `git merge`, and `git push`.

```bash
GIT_EDITOR=: EDITOR=: GIT_SEQUENCE_EDITOR=: GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 git <command>
```

Run read-only commands (`status`, `diff`, `log`, `show`, `blame`, `branch`, `rev-parse`, `merge-base`) without the prefix. They never open an editor, the shell has no terminal for a pager, and a `shell` permission pattern such as `git status*` matches on the start of the command, so the prefix can turn a pre-approved read into a permission prompt.
