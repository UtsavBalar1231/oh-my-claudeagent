// The inputs of the MCP tools the session had connected when this mod
// was last saved, from each server's tools/list inputSchema.
// Merges into the engine's ToolCallInput (types/ McpToolInputs) so
// `e.tool === "mcp__<server>__<tool>"` narrows to the tool's arguments.
// Written again at a save of the mod with a server connected.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Return a JSON array with one entry per agent file in the plugin's agents/ directory: name, description (the frontmatter description), default_model (the frontmatter model alias, "sonnet" when absent), and cost_tier (premium for fable, expensive for opus, cheap for sonnet and unknown values, free for haiku). The Agent tool's own agent list already carries names and descriptions; use this when the model or cost tier matters. */
    "mcp__plugin_oh-my-claudeagent_omca__agents_list": {}
    /** Moves agent memories and settings references that use an agent name listed in the rename table to its current name. Returns JSON { actions, collisions, mentions } and writes nothing unless apply is true. With apply it moves each oh-my-claudeagent-<old> memory directory under the project's .claude/agent-memory and .claude/agent-memory-local and the user config directory's agent-memory to oh-my-claudeagent-<new>, moving each file the target lacks and renaming a colliding file to <stem>.from-<old><ext>. merge_indexes also appends the lines of MEMORY.from-<old>.md that MEMORY.md lacks. It rewrites oh-my-claudeagent:<old> in the user, project and local settings.json and omca-<old> in opencode.json and opencode.jsonc, copying each file to <file>.bak-omca-migrate first. It only lists the CLAUDE.md, AGENTS.md, agent, command, skill and MEMORY.md files that name an old agent. */
    "mcp__plugin_oh-my-claudeagent_omca__agents_migrate": {
      /** Make the changes; false only reports them */
      apply?: boolean
      /** Append the lines of MEMORY.from-<old>.md that the target MEMORY.md lacks, then remove the from-file */
      merge_indexes?: boolean
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Dump the syntax tree of a code snippet. Use when building or debugging AST patterns. 'cst' shows full concrete syntax (use on target code), 'pattern' shows how ast-grep interprets a pattern (use when pattern doesn't match), 'ast' gives a simplified view. Returns the tree as text. */
    "mcp__plugin_oh-my-claudeagent_omca__ast_dump_tree": {
      /** Code snippet to visualize */
      code: string
      /** Language of the code */
      language: "bash" | "c" | "cpp" | "csharp" | "css" | "elixir" | "go" | "haskell" | "html" | "java" | "javascript" | "json" | "kotlin" | "lua" | "nix" | "php" | "python" | "ruby" | "rust" | "scala" | "solidity" | "swift" | "typescript" | "tsx" | "yaml"
      /** Tree format: cst (full concrete syntax tree), ast (omit unnamed nodes), pattern (how ast-grep interprets a pattern) */
      format?: "cst" | "ast" | "pattern"
    }
    /** Search code using a YAML rule with advanced combinators (kind, has, inside, follows, precedes, all, any, not). Use when ast_search patterns are insufficient, such as for context-sensitive matches like "function calls inside a class" or "imports followed by usage". Returns file:line:col with matched code and rule ID, 100 matches by default (max_results raises that to 500), with a [TRUNCATED] marker when more exist. */
    "mcp__plugin_oh-my-claudeagent_omca__ast_find_rule": {
      /** YAML rule with id, language, and rule fields. Example: id: find-imports language: python rule: pattern: import $MOD For relational rules (has, inside, follows, precedes), add `stopBy: end` to search the entire subtree, not just direct children. */
      rule_yaml: string
      /** Paths to search (default: ['.']) */
      paths?: string[]
      /** Maximum matches to return (default 100, at most 500) */
      max_results?: number
      /** Output format: text (compact) or json ({truncated, matches} with full match objects; truncated is true when more matches exist than returned) */
      output_format?: "text" | "json"
    }
    /** Rewrite code by syntax pattern with ast-grep, for structural refactors such as renaming a call, reordering arguments, or migrating an API. Paths must lie inside the project root or one of its git worktrees; any other path is rejected. Preview first: dry_run defaults to true and writes nothing; pass dry_run=false only once the preview shows the intended change set. The write goes to disk through ast-grep rather than the Edit tool, so Edit hooks and read-before-edit checks do not run. Returns list of replacements with file:line locations. Apply is refused when matches exceed the 500-match preview cap; narrow paths, globs, or the pattern until the full change set previews. */
    "mcp__plugin_oh-my-claudeagent_omca__ast_replace": {
      /** AST pattern to match */
      pattern: string
      /** Replacement pattern (can use $VAR from the match pattern) */
      rewrite: string
      /** Target language */
      lang: "bash" | "c" | "cpp" | "csharp" | "css" | "elixir" | "go" | "haskell" | "html" | "java" | "javascript" | "json" | "kotlin" | "lua" | "nix" | "php" | "python" | "ruby" | "rust" | "scala" | "solidity" | "swift" | "typescript" | "tsx" | "yaml"
      /** Paths to search */
      paths?: string[]
      /** Include/exclude globs */
      globs?: string[]
      /** Preview changes without applying (default: true) */
      dry_run?: boolean
    }
    /** Search code by syntax pattern with ast-grep. Use it instead of text search when the target is structural (function signatures, class shapes, import forms, call patterns); use rg for plain text, comments, or string contents. Paths must lie inside the project root or one of its git worktrees; any other path is rejected with an error, so search outside the repository with rg. Only files whose extension maps to lang are scanned (lang='cpp' skips .c files). Returns file:line:col and the matched line for each hit, 100 hits by default (max_results raises that to 500 or lowers it), with a [TRUNCATED] marker that says to narrow paths or globs or raise max_results when more exist; a zero-match result carries hints when the pattern uses regex syntax that ast-grep does not support. */
    "mcp__plugin_oh-my-claudeagent_omca__ast_search": {
      /** AST pattern with meta-variables ($VAR for single node, $$$ for multiple). Must be a complete AST node. */
      pattern: string
      /** Target language */
      lang: "bash" | "c" | "cpp" | "csharp" | "css" | "elixir" | "go" | "haskell" | "html" | "java" | "javascript" | "json" | "kotlin" | "lua" | "nix" | "php" | "python" | "ruby" | "rust" | "scala" | "solidity" | "swift" | "typescript" | "tsx" | "yaml"
      /** Paths to search (default: ['.']) */
      paths?: string[]
      /** Include/exclude globs (prefix ! to exclude) */
      globs?: string[]
      /** Context lines around each match */
      context?: number
      /** Maximum matches to return (default 100, at most 500) */
      max_results?: number
      /** Output format: text (compact) or json ({truncated, matches} with full match objects; truncated is true when more matches exist than returned) */
      output_format?: "text" | "json"
    }
    /** Test whether a YAML rule matches a code snippet. Use before running ast_find_rule across the codebase to validate rule correctness on a small example. Returns matched locations and snippets, or a no-match message with debugging hints. */
    "mcp__plugin_oh-my-claudeagent_omca__ast_test_rule": {
      /** Code snippet to test against */
      code: string
      /** YAML rule to test. Must include id, language, and rule fields. Example: id: test language: python rule: pattern: print($$$A) */
      rule_yaml: string
    }
    /** Return category-to-model mapping from categories.json. Use when selecting the right model tier for a task category. Returns JSON mapping of category names to model tier. */
    "mcp__plugin_oh-my-claudeagent_omca__categories_list": {}
    /** Record a build, test or lint run in the project's evidence log with its real exit code; a failing run counts too. OMCA's task gates read this log. Before completing a run's final task, log one final_verification entry with that task's task_id. */
    "mcp__plugin_oh-my-claudeagent_omca__evidence_log": {
      /** final_verification is a run's verdict. A run's final task cannot complete until one with exit_code 0 names its task_id. */
      evidence_type: "build" | "test" | "lint" | "manual" | "final_verification"
      /** Command that was executed */
      command: string
      /** The command's exit code. For final_verification, 0 records COMPLETE. */
      exit_code: number
      /** Relevant output snippet (truncated if needed) */
      output_snippet: string
      /** Agent or user who verified */
      verified_by?: string
      /** Project root (auto-detected from git) */
      working_directory?: string
      /** The id of the run's final task this verdict covers. Set it on final_verification entries only. */
      task_id?: string
    }
    /** Return the newest entries of the project's verification evidence log as JSON, oldest first, or a no-evidence message. It returns 20 entries by default and pass limit=0 for all; when entries are cut the output starts with a line giving the count shown and the total. The log is never cleared and is shared by all sessions in the project, so it holds entries from earlier sessions and other runs; there is no filter, and each output_snippet is capped at 2,000 characters. Use it to confirm what was logged, for example evidence a subagent reports. */
    "mcp__plugin_oh-my-claudeagent_omca__evidence_read": {
      /** Newest entries to return, oldest first. Default 20. Set to 0 for every entry. */
      limit?: number
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Read a text file with line numbers, a size footer, and offset/limit paging. Use it for a path the built-in Read tool cannot reach, typically one outside the working directories while permissions.blockReadsOutsideWorkingDirectories is on; that setting fences Read, Grep, Glob, and LSP but not MCP tools. Without a limit it returns up to 1000 lines and stops at the last whole line under 40,000 characters, and the footer names the offset to continue from; lines over 2000 characters are cut with a truncation marker. The footer's token figure estimates the whole file (bytes / 4), not the returned window, and names the next offset when lines remain. Refuses with a plain-text message, not an error: directories, devices, binary files (a null byte in the first 8 KB), unlimited reads (limit=0) of files over 3 MB, paths matching a sensitive-file denylist (.ssh, .gnupg, .aws, .env files, credentials*, *secret*, SSH private keys, /etc/shadow), and network paths (UNC, or /net/ on macOS). Each call is logged to .omca/logs/file-access.jsonl. */
    "mcp__plugin_oh-my-claudeagent_omca__file_read": {
      /** Absolute path to the file to read */
      path: string
      /** 0-based line offset. Use with limit to paginate large files (e.g. offset=500, limit=200 reads lines 501-700) */
      offset?: number
      /** Max lines to return. Default 1000 lines or 40,000 characters, whichever comes first. Set to 0 for unlimited (blocked for >3MB files). Use smaller values for targeted reads to save tokens. */
      limit?: number
      /** File encoding (default utf-8, falls back to latin-1) */
      encoding?: string
    }
    /** Report whether OMCA's runtime is active in this session, plus the client version, the ast-grep binary and the state files. `runtime` is `ok` when this session's settings hooks have reached the server and the OMCA mod has marked the session since the last prompt with Claude Code's task tools on; otherwise it is `hooks_inactive`, `mod_absent` or `task_tools_absent`, and `runtime_reason` names the likely cause. The orchestration skills call this first and stop unless `runtime` is `ok`. `client_version` is null when the client does not export its version. `ast_grep` is `{path}` or `{error}`. `state` gives the state directory as `present` or `absent` and `verification-evidence.json` as `absent`, `valid` or `invalid`: invalid is a file the evidence ledger reader refuses, which `evidence_log` will not replace. */
    "mcp__plugin_oh-my-claudeagent_omca__health_check": {
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Permanently delete the oldest entries of one notepad section until it fits 20 lines. It cuts whole entries only and always keeps the newest entry, even when that entry alone is longer than 20 lines. Removed text is not archived anywhere. The section then starts with a marker giving the total number of lines removed so far. Use it only when a section is too large to read usefully and its older entries no longer matter; read them with notepad_read first if they might. Returns a one-line summary, or a no-op message when the section already fits. */
    "mcp__plugin_oh-my-claudeagent_omca__notepad_compact": {
      /** The run's name, from its tasks' metadata.run */
      plan_name: string
      /** Notepad section to compact */
      section: "learnings" | "issues" | "decisions" | "problems"
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** List available notepads and their sections. Use to discover which plans have notepad data or to verify a notepad was created. Provide plan_name to list sections for a specific plan, or omit to list all plans. Returns plan names with their available section names. */
    "mcp__plugin_oh-my-claudeagent_omca__notepad_list": {
      /** Plan name (lists all plans if empty) */
      plan_name?: string
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Read notepad content for a plan. Use to review discoveries, open questions, or prior decisions before continuing work on a plan. Omit section to read all sections at once. Returns formatted markdown content or a not-found message. Past 40,000 characters it returns the newest content within that budget under a [TRUNCATED] header; read one section or run notepad_compact to bring older entries back into reach. */
    "mcp__plugin_oh-my-claudeagent_omca__notepad_read": {
      /** Plan name */
      plan_name: string
      /** Section to read (all if omitted) */
      section?: "learnings" | "issues" | "decisions" | "problems" | null
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Append a learning, issue, decision or problem to a plan's notepad section, where it survives compaction. Never overwrites. */
    "mcp__plugin_oh-my-claudeagent_omca__notepad_write": {
      /** The run's name, from its tasks' metadata.run */
      plan_name: string
      /** Notepad section to write to */
      section: "learnings" | "issues" | "decisions" | "problems"
      /** Content to append (markdown) */
      content: string
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Internal: OMCA's settings hooks call this. Not for direct use. */
    "mcp__plugin_oh-my-claudeagent_omca__omca_hook": {
      event: string
    }
    /** Search local Claude Code session transcripts for a project. Read-only; scans only the resolved project's own transcript directory under the client's projects directory (~/.claude/projects/<slug>/ by default), never other projects. Matches are case-insensitive substrings (no regex) over user/assistant/tool turn text, extracted from the JSONL block structure so hits land in readable text rather than raw JSON. Returns bounded, capped-excerpt matches (~200 chars around each hit), newest turns first, with a truncation note when more matches exist than were returned. Malformed transcript lines are skipped silently. Large tool results that the client spilled to <session>/tool-results/*.txt are scanned as well and reported with role "tool", ordered by file mtime since they carry no timestamp; the truncated inline copy of a scanned sidecar is not reported a second time; subagent transcripts under <session>/subagents/ are not scanned. Privacy: reads local conversation history; excerpts may contain prior session content. */
    "mcp__plugin_oh-my-claudeagent_omca__session_search": {
      /** Case-insensitive substring to search for. No regex support. */
      query: string
      /** Project root (default: cwd's git root) */
      project_path?: string
      /** Filter to one role: user, assistant, or tool. Empty = all roles. */
      role?: "" | "user" | "assistant" | "tool"
      /** Max matches to return (default 10, hard max 50). */
      limit?: number
    }
    /** Read one task of Claude Code's task list as JSON, from any agent: its subject, description, status, owner, links, run, final and blocked marks, and other metadata. blockedBy names every link and openBlockers the ones still holding it: a task completed or closed as blocked holds nothing back. A task closed as blocked keeps its last status (pending or in_progress), with its reason in blockedReason. Read-only: the main session changes the list. */
    "mcp__plugin_oh-my-claudeagent_omca__task_get": {
      /** The task's id, as task_list prints it without the # */
      taskId: string
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Read Claude Code's task list from any agent: each task's id, status and subject under its run, which task is the run's final one, the open tasks it waits on, and why a task was closed as blocked. A task completed or closed as blocked holds nothing back. A subagent in the background has no TaskList, and TaskList leaves out the run, final and blocked marks. Read-only: the main session changes the list. */
    "mcp__plugin_oh-my-claudeagent_omca__task_list": {
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
  }
}
