// The inputs of the MCP tools the session had connected when this mod
// was last saved, from each server's tools/list inputSchema.
// Merges into the engine's ToolCallInput (types/ McpToolInputs) so
// `e.tool === "mcp__<server>__<tool>"` narrows to the tool's arguments.
// Written again at a save of the mod with a server connected.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    /** Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework. You must call 'Resolve Context7 Library ID' tool first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query. Do not call this tool more than 3 times per question. */
    "mcp__plugin_oh-my-claudeagent_context7__query-docs": {
      /** Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'. */
      libraryId: string
      /** What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the user's question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query. */
      query: string
    }
    /** Resolves a package/product name to a Context7-compatible library ID and returns matching libraries. You MUST call this function before 'Query Documentation' tool to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query. Each result includes: - Library ID: Context7-compatible identifier (format: /org/project) - Name: Library or package name - Description: Short summary - Code Snippets: Number of available code examples - Source Reputation: Authority indicator (High, Medium, Low, or Unknown) - Benchmark Score: Quality indicator (100 is the highest score) - Versions: List of versions if available. Use one of those versions if the user provides a version in their query. The format of the version is /org/project/version. For best results, select libraries based on name match, source reputation, snippet coverage, benchmark score, and relevance to your use case. Selection Process: 1. Analyze the query to understand what library/package the user is looking for 2. Return the most relevant match based on: - Name similarity to the query (exact matches prioritized) - Description relevance to the query's intent - Documentation coverage (prioritize libraries with higher Code Snippet counts) - Source reputation (consider libraries with High or Medium reputation more authoritative) - Benchmark Score: Quality indicator (100 is the highest score) Response Format: - Return the selected library ID in a clearly marked section - Provide a brief explanation for why this library was chosen - If multiple good matches exist, acknowledge this but proceed with the most relevant one - If no good matches exist, clearly state this and suggest query refinements For ambiguous queries, request clarification before proceeding with a best-guess match. IMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have. */
    "mcp__plugin_oh-my-claudeagent_context7__resolve-library-id": {
      /** What to look up in the library's documentation. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query. */
      query: string
      /** Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'. */
      libraryName: string
    }
    /** Find real-world code examples from over a million public GitHub repositories to help answer programming questions. **IMPORTANT: This tool searches for literal code patterns (like grep), not keywords. Search for actual code that would appear in files:** - ✅ Good: 'useState(', 'import React from', 'async function', '(?s)try {.*await' - ❌ Bad: 'react tutorial', 'best practices', 'how to use' **When to use this tool:** - When implementing unfamiliar APIs or libraries and need to see real usage patterns - When unsure about correct syntax, parameters, or configuration for a specific library - When looking for production-ready examples and best practices for implementation - When needing to understand how different libraries or frameworks work together **Perfect for questions like:** - "How do developers handle authentication in Next.js apps?" → Search: 'getServerSession' with language=['TypeScript', 'TSX'] - "What are common React error boundary patterns?" → Search: 'ErrorBoundary' with language=['TSX'] - "Show me real useEffect cleanup examples" → Search: '(?s)useEffect\(\(\) => {.*removeEventListener' with useRegexp=true - "How do developers handle CORS in Flask applications?" → Search: 'CORS(' with matchCase=true and language=['Python'] Use regular expressions with useRegexp=true for flexible patterns like '(?s)useState\(.*loading' to find useState hooks with loading-related variables. Prefix the pattern with '(?s)' to match across multiple lines. Filter by language, repository, or file path to narrow results. */
    "mcp__plugin_oh-my-claudeagent_grep__searchGitHub": {
      /** The literal code pattern to search for (e.g., 'useState(', 'export function'). Use actual code that would appear in files, not keywords or questions. */
      query: string
      /** Whether the search should be case sensitive */
      matchCase?: boolean
      /** Whether to match whole words only */
      matchWholeWords?: boolean
      /** Whether to interpret the query as a regular expression */
      useRegexp?: boolean
      /** Filter by repository. Examples: 'facebook/react', 'microsoft/vscode', 'vercel/ai'. Can match partial names, for example 'vercel/' will find repositories in the vercel org. */
      repo?: string
      /** Filter by file path. Examples: 'src/components/Button.tsx', 'README.md'. Can match partial paths, for example '/route.ts' will find route.ts files at any level. */
      path?: string
      /** Filter by programming language. Examples: ['TypeScript', 'TSX'], ['JavaScript'], ['Python'], ['Java'], ['C#'], ['Markdown'], ['YAML'] */
      language?: string[]
    }
    /** Return a JSON array with one entry per agent file in the plugin's agents/ directory: name, description (the frontmatter description), default_model (the frontmatter model alias, "sonnet" when absent), and cost_tier (premium for fable, expensive for opus, cheap for sonnet and unknown values, free for haiku). The Agent tool's own agent list already carries names and descriptions; use this when the model or cost tier matters. */
    "mcp__plugin_oh-my-claudeagent_omca__agents_list": {}
    /** Dump the syntax tree of a code snippet. Use when building or debugging AST patterns — 'cst' shows full concrete syntax (use on target code), 'pattern' shows how ast-grep interprets a pattern (use when pattern doesn't match), 'ast' gives a simplified view. Returns tree output to stderr (captured here as the return value). */
    "mcp__plugin_oh-my-claudeagent_omca__ast_dump_tree": {
      /** Code snippet to visualize */
      code: string
      /** Language of the code */
      language: "bash" | "c" | "cpp" | "csharp" | "css" | "elixir" | "go" | "haskell" | "html" | "java" | "javascript" | "json" | "kotlin" | "lua" | "nix" | "php" | "python" | "ruby" | "rust" | "scala" | "solidity" | "swift" | "typescript" | "tsx" | "yaml"
      /** Tree format: cst (full concrete syntax tree), ast (omit unnamed nodes), pattern (how ast-grep interprets a pattern) */
      format?: "cst" | "ast" | "pattern"
    }
    /** Search code using a YAML rule with advanced combinators (kind, has, inside, follows, precedes, all, any, not). Use when ast_search patterns are insufficient — for context-sensitive matches like "function calls inside a class" or "imports followed by usage". Returns file:line:col with matched code and rule ID. */
    "mcp__plugin_oh-my-claudeagent_omca__ast_find_rule": {
      /** YAML rule with id, language, and rule fields. Example: id: find-imports language: python rule: pattern: import $MOD For relational rules (has, inside, follows, precedes), add `stopBy: end` to search the entire subtree, not just direct children. */
      rule_yaml: string
      /** Paths to search (default: ['.']) */
      paths?: string[]
      /** Maximum matches to return */
      max_results?: number
      /** Output format: text (compact) or json (full) */
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
    /** Search code by syntax pattern with ast-grep. Use it instead of text search when the target is structural (function signatures, class shapes, import forms, call patterns); use rg for plain text, comments, or string contents. Paths must lie inside the project root or one of its git worktrees; any other path is rejected with an error, so search outside the repository with rg. Only files whose extension maps to lang are scanned (lang='cpp' skips .c files). Returns file:line:col and the matched line for each hit, at most 500 hits (max_results can lower that), with a [TRUNCATED] marker when more exist; a zero-match result carries hints when the pattern uses regex syntax that ast-grep does not support. */
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
      /** Maximum matches to return */
      max_results?: number
      /** Output format: text (compact) or json (full) */
      output_format?: "text" | "json"
    }
    /** Test whether a YAML rule matches a code snippet. Use before running ast_find_rule across the codebase to validate rule correctness on a small example. Returns matched locations and snippets, or a no-match message with debugging hints. */
    "mcp__plugin_oh-my-claudeagent_omca__ast_test_rule": {
      /** Code snippet to test against */
      code: string
      /** YAML rule to test. Must include id, language, and rule fields. Example: id: test language: python rule: pattern: print($$$A) */
      rule_yaml: string
    }
    /** Count a plan file's numbered checkboxes (`- [ ] N.` and `- [x] N.`; unnumbered boxes are ignored) and return progress. Use to report plan status or to find the next task. With plan_path, reads that file. Otherwise it looks up plan_name in the registry, or else this session's binding; a session with no binding falls back to the only registered plan, or to the most recently started one, which may belong to another session, so pass plan_name or plan_path when several plans exist. Returns JSON with total, completed, remaining, is_complete, plan_path, plan_sha256 (hex SHA-256 of the plan file's current bytes, the value evidence_log takes for a final_verification entry), and next_task_label (the first unchecked task, truncated to 80 chars, or null when none remain); a JSON error object with plan_missing when the plan file is gone; or a plain message when no plan resolves. */
    "mcp__plugin_oh-my-claudeagent_omca__boulder_progress": {
      /** Path to plan file (resolves from boulder registry if empty) */
      plan_path?: string
      /** Named plan in the registry to check (bypasses session resolution) */
      plan_name?: string
      /** Session ID used to resolve the bound plan when plan_path/plan_name are omitted */
      session_id?: string
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Register a work plan in the project's plan registry (.omca/state/boulder.json) and bind this session to it. Upserts plans[plan_name], keeping its started_at and adding session_id to its session_ids, then prunes bindings older than 7 days and unbound, finished plans of that age. Binding turns on plan enforcement for this session: while numbered tasks (`- [ ] N.`) remain unchecked, the Stop hook blocks the stop with a nudge to continue, and once all are checked it blocks until a final_verification evidence entry matches the plan. Call it once before executing a plan; calling it again is safe. Returns a confirmation with the plan name and session count. */
    "mcp__plugin_oh-my-claudeagent_omca__boulder_write": {
      /** Absolute path to the plan file */
      active_plan: string
      /** Short name for the plan */
      plan_name: string
      /** This session's platform UUID, as shown on the 'Session <id>' line OMCA adds to the session's first prompt. An empty string uses the session of the most recent OMCA hook call, or the server's CLAUDE_CODE_SESSION_ID before any hook has run. Any other value binds a session that does not exist, and the Stop hooks will not see the plan. */
      session_id: string
      /** Agent managing this plan */
      agent?: string
      /** Git worktree path if using worktrees */
      worktree_path?: string
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Return category-to-model mapping from categories.json. Use when selecting the right model tier for a task category. Returns JSON mapping of category names to model tier. */
    "mcp__plugin_oh-my-claudeagent_omca__categories_list": {
      /** Unused; the table is read from the plugin directory. */
      working_directory?: string
    }
    /** Append a timestamped entry to the project's verification evidence log (.omca/evidence/verification-evidence.json), the audit trail OMCA's gates read. Use it after each build, test, or lint run, with the run's real exit code (a failing run is still evidence), and once at the end of a plan for the final_verification verdict. Two gates read the log: a plan-bound session cannot stop until a final_verification entry matches the plan (see evidence_type), and when task tools are enabled a TaskCompleted hook refuses to close a task if a verification run finished after the log was last written. Entries are never removed and are shared by every session in the project. Returns a confirmation with the total entry count. */
    "mcp__plugin_oh-my-claudeagent_omca__evidence_log": {
      /** Kind of evidence. final_verification is the end-of-plan completeness verdict. The plan Stop gate accepts only a final_verification entry with exit_code 0 whose plan_sha256 matches the plan file's current SHA-256; an entry without plan_sha256 matches any plan, and editing the plan after logging makes a scoped entry stop matching. */
      evidence_type: "build" | "test" | "lint" | "manual" | "final_verification"
      /** Command that was executed */
      command: string
      /** Exit code of the command. For final_verification, 0 records COMPLETE and any other value INCOMPLETE. */
      exit_code: number
      /** Relevant output snippet (truncated if needed) */
      output_snippet: string
      /** Agent or user who verified */
      verified_by?: string
      /** Project root (auto-detected from git) */
      working_directory?: string
      /** Hex SHA-256 of the plan file's current bytes, as `boulder_progress` returns it in `plan_sha256`. Set it on final_verification entries so the verdict applies only to this version of the plan; leave empty for other types. */
      plan_sha256?: string
    }
    /** Return every entry in the project's verification evidence log as JSON, oldest first, or a no-evidence message. The log is never cleared and is shared by all sessions in the project, so it holds entries from earlier sessions and other plans; there is no filter or paging, and each output_snippet is capped at 2,000 characters. Use it to confirm what was logged, for example evidence a subagent reports. */
    "mcp__plugin_oh-my-claudeagent_omca__evidence_read": {
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Read a text file with line numbers, a size footer, and offset/limit paging. Use it for a path the built-in Read tool cannot reach, typically one outside the working directories while permissions.blockReadsOutsideWorkingDirectories is on; that setting fences Read, Grep, Glob, and LSP but not MCP tools. Default limit is 5000 lines; lines over 2000 characters are cut with a truncation marker. The footer's token figure estimates the whole file (bytes / 4), not the returned window, and names the next offset when lines remain. Refuses with a plain-text message, not an error: directories, devices, binary files (a null byte in the first 8 KB), unlimited reads (limit=0) of files over 3 MB, and paths matching a sensitive-file denylist (.ssh, .gnupg, .aws, .env files, credentials*, *secret*, SSH private keys, /etc/shadow). Each call is logged to .omca/logs/file-access.jsonl. */
    "mcp__plugin_oh-my-claudeagent_omca__file_read": {
      /** Absolute path to the file to read */
      path: string
      /** 0-based line offset. Use with limit to paginate large files (e.g. offset=500, limit=200 reads lines 501-700) */
      offset?: number
      /** Max lines to return. Default 5000. Set to 0 for unlimited (blocked for >3MB files). Use smaller values for targeted reads to save tokens. */
      limit?: number
      /** File encoding (default utf-8, falls back to latin-1) */
      encoding?: string
    }
    /** Report whether OMCA's runtime is active in this session, plus the client version, the ast-grep binary and the state files. `runtime` is `ok` when this session's settings hooks have reached the server and the OMCA mod has marked the session since the last prompt; otherwise it is `hooks_inactive` or `mod_absent`, and `runtime_reason` names the likely cause. The orchestration skills call this first and stop unless `runtime` is `ok`. `client_version` is null when the client does not export its version. `ast_grep` is `{path}` or `{error}`. `state` gives the state directory as `present` or `absent` and `boulder.json` and `verification-evidence.json` as `absent`, `valid` or `invalid` JSON. */
    "mcp__plugin_oh-my-claudeagent_omca__health_check": {
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Permanently delete all but the last 20 lines of one notepad section. The cut is by line, not by entry, so an entry that straddles it loses its first lines and its timestamp header, and removed text is not archived anywhere. The section then starts with a marker giving the number of removed lines. Use it only when a section is too large to read usefully and its older entries no longer matter; read them with notepad_read first if they might. Returns a one-line summary, or a no-op message when the section has 20 lines or fewer. */
    "mcp__plugin_oh-my-claudeagent_omca__notepad_compact": {
      /** Plan name (matches boulder plan_name) */
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
    /** Read notepad content for a plan. Use to review discoveries, open questions, or prior decisions before continuing work on a plan. Omit section to read all sections at once. Returns formatted markdown content or a not-found message. */
    "mcp__plugin_oh-my-claudeagent_omca__notepad_read": {
      /** Plan name */
      plan_name: string
      /** Section to read (all if omitted) */
      section?: "learnings" | "issues" | "decisions" | "problems" | null
      /** Project root (auto-detected from git) */
      working_directory?: string
    }
    /** Append content to a notepad section during plan execution. Use to record learnings, issues, decisions, or problems discovered while working. Always appends, never overwrites — safe to call multiple times. Returns confirmation with the updated section path. */
    "mcp__plugin_oh-my-claudeagent_omca__notepad_write": {
      /** Plan name (matches boulder plan_name) */
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
      role?: string
      /** Max matches to return (default 10, hard max 50). */
      limit?: number
    }
  }
}
