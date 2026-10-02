import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spillPointer, tools } from "./sessions.ts";

const sessionSearch = (() => {
  const found = tools.find((tool) => tool.name === "session_search");
  if (found === undefined) throw new Error("no tool named session_search");
  return found;
})();

const TIME = "2026-01-01T00:00:00Z";
const EXCERPT_RADIUS = 100;
const ENV = ["OMCA_TRANSCRIPTS_ROOT", "CLAUDE_CONFIG_DIR"] as const;
const savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

type Match = { file: string; timestamp: string; role: string; excerpt: string };
type Result = { query: string; project_path: string; slug: string; matches: Match[]; truncated: boolean; note?: string };

let base = "";
let project = "";
let slug = "";
let projectDir = "";

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "omca-sessions-")));
  project = join(base, "project");
  mkdirSync(project);
  expect(Bun.spawnSync(["git", "init", "-q", project], { env: process.env }).exitCode).toBe(0);
  slug = project.replace(/[^A-Za-z0-9]/g, "-");
  process.env.OMCA_TRANSCRIPTS_ROOT = join(base, "projects");
  projectDir = join(base, "projects", slug);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  for (const name of ENV) {
    const value = savedEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

const turn = (type: "user" | "assistant", content: unknown, timestamp = TIME) => ({
  type,
  timestamp,
  message: { role: type, content },
});
const text = (value: string) => ({ type: "text", text: value });
const toolResult = (content: unknown) => ({ type: "tool_result", content });

function writeFile(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const transcript = (name: string, ...lines: unknown[]): string =>
  writeFile(join(projectDir, name), lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
const sidecar = (session: string, name: string, body: string): string =>
  writeFile(join(projectDir, session, "tool-results", name), body);
const setMtime = (path: string, seconds: number) => utimesSync(path, seconds, seconds);

const raw = async (args: Record<string, unknown>): Promise<string> => sessionSearch.call({ project_path: project, ...args });
const search = async (args: Record<string, unknown>): Promise<Result> => JSON.parse(await raw(args));

test("session_search is declared as the only tool of the module, read-only", () => {
  expect(tools.map((tool) => tool.name)).toEqual(["session_search"]);
  expect(sessionSearch.annotations.readOnlyHint).toBe(true);
});

test("a hit comes back as two-space-indented JSON with the file, timestamp, role and excerpt", async () => {
  transcript("session1.jsonl", turn("assistant", [text("the migration plan is solid")], "2026-03-04T05:06:07Z"));
  const expected = {
    query: "migration plan",
    project_path: project,
    slug,
    matches: [{ file: "session1.jsonl", timestamp: "2026-03-04T05:06:07Z", role: "assistant", excerpt: "the migration plan is solid" }],
    truncated: false,
  };
  expect(await raw({ query: "migration plan" })).toBe(JSON.stringify(expected, null, 2));
});

test("matching is a case-insensitive substring and the excerpt keeps the original case", async () => {
  transcript("s.jsonl", turn("user", "Please FIX the Bug now"));
  expect((await search({ query: "fix the bug" })).matches).toEqual([
    { file: "s.jsonl", timestamp: TIME, role: "user", excerpt: "Please FIX the Bug now" },
  ]);
});

test("an excerpt reaches 100 characters either side of the hit and stops at the text's ends", async () => {
  transcript(
    "s.jsonl",
    turn("user", `${"a".repeat(300)}NEEDLE${"b".repeat(300)}`),
    turn("user", `ab NEEDLE ${"c".repeat(150)}`),
    turn("user", `${"d".repeat(150)} NEEDLE end`),
  );
  expect((await search({ query: "needle" })).matches.map((match) => match.excerpt)).toEqual([
    `${"d".repeat(99)} NEEDLE end`,
    `ab NEEDLE ${"c".repeat(99)}`,
    `${"a".repeat(100)}NEEDLE${"b".repeat(100)}`,
  ]);
});

test("the role filter keeps one role, and an unknown role filters nothing", async () => {
  transcript("s.jsonl", turn("user", "banana split"), turn("assistant", [text("banana bread recipe")]));
  expect((await search({ query: "banana", role: "user" })).matches.map((match) => match.role)).toEqual(["user"]);
  expect((await search({ query: "banana", role: "assistant" })).matches.map((match) => match.excerpt)).toEqual(["banana bread recipe"]);
  expect((await search({ query: "banana", role: "system" })).matches.map((match) => match.role)).toEqual(["assistant", "user"]);
});

test("tool use input and tool results of every shape are role tool, whatever message carries them", async () => {
  transcript(
    "s.jsonl",
    turn("user", [toolResult("build succeeded with 0 errors")]),
    turn("user", [toolResult([{ type: "text", text: "lint succeeded in a list" }, { type: "image" }])]),
    turn("assistant", [{ type: "tool_use", name: "Bash", input: { command: "echo succeeded" } }]),
    turn("user", [text("it succeeded for the user")]),
  );
  const result = await search({ query: "succeeded" });
  expect(result.matches.map(({ role, excerpt }) => [role, excerpt])).toEqual([
    ["user", "it succeeded for the user"],
    ["tool", '{"command":"echo succeeded"}'],
    ["tool", "lint succeeded in a list"],
    ["tool", "build succeeded with 0 errors"],
  ]);
  expect((await search({ query: "succeeded", role: "tool" })).matches).toHaveLength(3);
});

test("turns come newest first and the hits inside one turn keep their order", async () => {
  transcript(
    "s.jsonl",
    turn("user", "needle first turn"),
    turn("assistant", [text("needle in text"), { type: "tool_use", name: "Read", input: { file_path: "needle.ts" } }]),
    turn("user", "needle last turn"),
  );
  expect((await search({ query: "needle" })).matches.map(({ role, excerpt }) => [role, excerpt])).toEqual([
    ["user", "needle last turn"],
    ["assistant", "needle in text"],
    ["tool", '{"file_path":"needle.ts"}'],
    ["user", "needle first turn"],
  ]);
});

test("transcripts are searched newest file first", async () => {
  setMtime(transcript("old.jsonl", turn("user", "needle in old")), 1_700_000_000);
  setMtime(transcript("new.jsonl", turn("user", "needle in new")), 1_800_000_000);
  expect((await search({ query: "needle" })).matches.map((match) => match.file)).toEqual(["new.jsonl", "old.jsonl"]);
});

test("a limit below the match count truncates, keeps the newest and says how many were returned", async () => {
  transcript("s.jsonl", ...Array.from({ length: 5 }, (_, index) => turn("user", `needle occurrence ${index}`)));
  const result = await search({ query: "needle", limit: 2 });
  expect(result.matches.map((match) => match.excerpt)).toEqual(["needle occurrence 4", "needle occurrence 3"]);
  expect(result.truncated).toBe(true);
  expect(result.note).toBe("[TRUNCATED] returned 2 of possibly more matches; raise limit (max 50) to see more");
});

test("a limit equal to the match count is not truncated", async () => {
  transcript("s.jsonl", ...Array.from({ length: 3 }, (_, index) => turn("user", `needle ${index}`)));
  const result = await search({ query: "needle", limit: 3 });
  expect(result.matches).toHaveLength(3);
  expect(result.truncated).toBe(false);
  expect(result).not.toHaveProperty("note");
});

test("truncation is found across files too", async () => {
  setMtime(transcript("a.jsonl", turn("user", "needle a")), 1_700_000_000);
  setMtime(transcript("b.jsonl", turn("user", "needle b")), 1_800_000_000);
  const result = await search({ query: "needle", limit: 1 });
  expect(result.matches.map((match) => match.file)).toEqual(["b.jsonl"]);
  expect(result.truncated).toBe(true);
});

test("the limit is clamped to between 1 and 50", async () => {
  transcript("s.jsonl", ...Array.from({ length: 60 }, (_, index) => turn("user", `needle ${index}`)));
  const high = await search({ query: "needle", limit: 1000 });
  expect(high.matches.map((match) => match.excerpt)).toEqual(Array.from({ length: 50 }, (_, index) => `needle ${59 - index}`));
  expect(high.truncated).toBe(true);
  for (const limit of [0, -5]) {
    const low = await search({ query: "needle", limit });
    expect(low.matches.map((match) => match.excerpt)).toEqual(["needle 59"]);
    expect(low.truncated).toBe(true);
  }
});

test("lines that are not turns are skipped without failing the search", async () => {
  transcript(
    "s.jsonl",
    "{not valid json",
    "",
    "[1, 2]",
    { type: "system", message: { content: "needle in a system record" } },
    { type: "user" },
    { type: "user", message: "needle in a string message" },
    turn("assistant", [text("needle here")]),
  );
  expect((await search({ query: "needle" })).matches.map((match) => match.excerpt)).toEqual(["needle here"]);
});

test("a turn without a string timestamp reports an empty one", async () => {
  transcript("s.jsonl", { type: "user", message: { content: "needle" } });
  expect((await search({ query: "needle" })).matches[0]?.timestamp).toBe("");
});

test("a spilled tool result is searched and reported with its session, mtime and a 200 character excerpt", async () => {
  setMtime(sidecar("sess-a", "spill1.txt", `${"x".repeat(500)}needle in the spill${"y".repeat(500)}`), 1_700_000_000);
  expect((await search({ query: "needle in the spill" })).matches).toEqual([
    {
      file: "sess-a/tool-results/spill1.txt",
      timestamp: "2023-11-14T22:13:20Z",
      role: "tool",
      excerpt: `${"x".repeat(100)}needle in the spill${"y".repeat(100)}`,
    },
  ]);
});

test("a spilled result reports only its first hit, with its context across line breaks", async () => {
  sidecar("sess-a", "spill1.txt", "first line\nthe needle line\nlast line\nneedle again\n");
  expect((await search({ query: "needle" })).matches.map((match) => match.excerpt)).toEqual([
    "first line\nthe needle line\nlast line\nneedle again\n",
  ]);
});

test("a hit that straddles a read chunk boundary is found with the exact excerpt", async () => {
  const body = `${"p".repeat(65_533)}NEEDLE${"q".repeat(150_000)}`;
  sidecar("sess-a", "big.txt", body);
  const result = await search({ query: "needle" });
  expect(result.matches.map((match) => match.excerpt)).toEqual([`${"p".repeat(100)}NEEDLE${"q".repeat(100)}`]);
});

test("a hit within 100 characters of the end of a spilled result gets a shorter excerpt", async () => {
  sidecar("sess-a", "tail.txt", `${"p".repeat(200_000)}the NEEDLE at the end`);
  expect((await search({ query: "needle" })).matches.map((match) => match.excerpt)).toEqual([`${"p".repeat(96)}the NEEDLE at the end`]);
});

test("a spilled result without the query reports nothing", async () => {
  sidecar("sess-a", "none.txt", `${"p".repeat(200_000)}nope`);
  expect((await search({ query: "needle" })).matches).toEqual([]);
});

test("spilled results are skipped when the role filter is not tool", async () => {
  sidecar("sess-a", "spill1.txt", "needle in the spill");
  expect((await search({ query: "needle", role: "user" })).matches).toEqual([]);
  expect((await search({ query: "needle", role: "tool" })).matches).toHaveLength(1);
});

test("a spilled result and a transcript are ordered together by mtime", async () => {
  setMtime(transcript("session1.jsonl", turn("user", "needle in the jsonl")), 1_700_000_000);
  setMtime(sidecar("sess-a", "spill1.txt", "needle in the spill"), 1_800_000_000);
  expect((await search({ query: "needle" })).matches.map((match) => match.role)).toEqual(["tool", "user"]);
});

test("subagent transcripts and anything below subagents/ are out of scope", async () => {
  transcript(join("sess-a", "subagents", "workflows", "wf_1", "agent-1.jsonl"), turn("assistant", [text("needle from a subagent")]));
  sidecar(join("sess-a", "subagents"), "agent-spill.txt", "needle in a subagent spill");
  expect((await search({ query: "needle" })).matches).toEqual([]);
});

const pointer = (path: string, preview: string) =>
  `<persisted-output>\nOutput too large (47.5KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;

test("the inline pointer to a scanned spilled result is not reported a second time", async () => {
  const body = `needle in the spill${"y".repeat(500)}`;
  const path = sidecar("sess-a", "spill1.txt", body);
  transcript("sess-a.jsonl", turn("user", [toolResult(pointer(path, body.slice(0, 200)))]));
  expect((await search({ query: "needle in the spill" })).matches.map((match) => match.file)).toEqual(["sess-a/tool-results/spill1.txt"]);
});

test("the inline pointer to a scanned spilled result in a directory with spaces is not reported a second time", async () => {
  const body = `needle in the spaced spill${"y".repeat(500)}`;
  const path = sidecar("sess a", "spill1.txt", body);
  transcript("sess-a.jsonl", turn("user", [toolResult(pointer(path, body.slice(0, 200)))]));
  expect((await search({ query: "needle in the spaced spill" })).matches.map((match) => match.file)).toEqual(["sess a/tool-results/spill1.txt"]);
});

test.each([
  ["POSIX path", pointer("/srv/u/.claude/projects/p/s1/tool-results/abc.txt", "x"), "/srv/u/.claude/projects/p/s1/tool-results/abc.txt"],
  ["path with spaces", pointer("/srv/Me Too/.claude/projects/p/s 1/tool-results/abc.txt", "x"), "/srv/Me Too/.claude/projects/p/s 1/tool-results/abc.txt"],
  ["drive path", pointer("C:\\Users\\x\\.claude\\projects\\p\\s1\\tool-results\\abc.txt", "x"), "C:\\Users\\x\\.claude\\projects\\p\\s1\\tool-results\\abc.txt"],
  ["drive path with spaces", pointer("C:\\Users\\Me Too\\.claude\\projects\\p\\tool-results\\abc.txt", "x"), "C:\\Users\\Me Too\\.claude\\projects\\p\\tool-results\\abc.txt"],
  ["forward-slash drive path", pointer("C:/Volumes/x/.claude/projects/p/s1/tool-results/abc.txt", "x"), "C:/Volumes/x/.claude/projects/p/s1/tool-results/abc.txt"],
  ["UNC path", pointer("\\\\srv\\share\\.claude\\projects\\p\\tool-results\\abc.txt", "x"), "\\\\srv\\share\\.claude\\projects\\p\\tool-results\\abc.txt"],
  ["bare mention", "see /srv/u/p/tool-results/abc.txt for more", "/srv/u/p/tool-results/abc.txt"],
  ["bare drive mention", "see C:\\p\\tool-results\\abc.txt for more", "C:\\p\\tool-results\\abc.txt"],
  ["a number before the path", "line 5/6 saved to: /h/p/tool-results/abc.txt", "/h/p/tool-results/abc.txt"],
])("the spill pointer in %s is read whole", (_name, text, expected) => {
  expect(spillPointer(text)).toBe(expected);
});

test.each(["no pointer here", "/srv/u/p/tool-results/abc.md", "/srv/u/p/tool-results/dir/abc.txt", "tool-results/abc.txt", "C:\\p\\results\\abc.txt"])(
  "%p holds no spill pointer",
  (text) => {
    expect(spillPointer(text)).toBeUndefined();
  },
);

test("the inline pointer to a spilled result that is gone still matches", async () => {
  const path = join(projectDir, "sess-a", "tool-results", "swept.txt");
  transcript("sess-a.jsonl", turn("user", [toolResult(pointer(path, "needle in the spill"))]));
  const [match] = (await search({ query: "needle in the spill" })).matches;
  expect([match?.file, match?.role]).toEqual(["sess-a.jsonl", "tool"]);
});

test("a plain tool result still matches while spilled results exist", async () => {
  sidecar("sess-a", "spill1.txt", "unrelated spill body");
  transcript("sess-a.jsonl", turn("user", [toolResult("needle stayed inline")]));
  expect((await search({ query: "needle stayed inline" })).matches.map((match) => match.file)).toEqual(["sess-a.jsonl"]);
});

test("a project with no transcript directory returns no matches and a note naming the directory", async () => {
  const other = join(base, "other");
  mkdirSync(other);
  expect(Bun.spawnSync(["git", "init", "-q", other], { env: process.env }).exitCode).toBe(0);
  const otherSlug = other.replace(/[^A-Za-z0-9]/g, "-");
  expect(await search({ query: "anything", project_path: other })).toEqual({
    query: "anything",
    project_path: other,
    slug: otherSlug,
    matches: [],
    truncated: false,
    note: `no transcript directory found at ${join(base, "projects", otherSlug)}`,
  });
});

test("the project is the git root of project_path, and other projects' transcripts are not read", async () => {
  transcript("s.jsonl", turn("user", "needle of this project"));
  const sibling = join(base, "projects", `${slug}-sibling`);
  writeFile(join(sibling, "s.jsonl"), `${JSON.stringify(turn("user", "needle of a sibling"))}\n`);
  mkdirSync(join(project, "sub"));
  const result = await search({ query: "needle", project_path: join(project, "sub") });
  expect(result.project_path).toBe(project);
  expect(result.matches.map((match) => match.excerpt)).toEqual(["needle of this project"]);
});

test("transcripts live under CLAUDE_CONFIG_DIR/projects unless OMCA_TRANSCRIPTS_ROOT overrides it", async () => {
  delete process.env.OMCA_TRANSCRIPTS_ROOT;
  process.env.CLAUDE_CONFIG_DIR = join(base, "config");
  writeFile(join(base, "config", "projects", slug, "s.jsonl"), `${JSON.stringify(turn("user", "needle from the config dir"))}\n`);
  expect((await search({ query: "needle" })).matches.map((match) => match.excerpt)).toEqual(["needle from the config dir"]);
  process.env.OMCA_TRANSCRIPTS_ROOT = join(base, "projects");
  expect((await search({ query: "needle" })).matches).toEqual([]);
});

test("a 6 MiB transcript is searched newest turn first, with the excerpts and ordering intact", async () => {
  const records = 20_000;
  const filler = "lorem ipsum € é dolor sit amet ".repeat(10);
  const path = transcript(
    "big.jsonl",
    ...Array.from({ length: records }, (_, index) => {
      const marker = index === 3 || index === 10_000 || index === records - 1 ? ` MARKER-${index}` : "";
      return turn("user", `${filler}${marker}`, `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}Z`);
    }),
  );
  expect(statSync(path).size).toBeGreaterThan(6 * 1024 * 1024);

  const marked = await search({ query: "marker-" });
  const excerptOf = (index: number) => `${filler} MARKER-${index}`.slice(filler.length + 1 - EXCERPT_RADIUS);
  expect(marked.matches.map((match) => match.excerpt)).toEqual([excerptOf(19_999), excerptOf(10_000), excerptOf(3)]);
  expect(marked.matches.map((match) => match.timestamp)).toEqual(["2026-01-01T00:00:19Z", "2026-01-01T00:00:40Z", "2026-01-01T00:00:03Z"]);
  expect(marked.truncated).toBe(false);

  const everywhere = await search({ query: "dolor", limit: 3 });
  expect(everywhere.matches.map((match) => match.timestamp)).toEqual(["2026-01-01T00:00:19Z", "2026-01-01T00:00:18Z", "2026-01-01T00:00:17Z"]);
  expect(everywhere.truncated).toBe(true);
});

test("a query or limit of the wrong type is rejected as an error", async () => {
  await expect(sessionSearch.call({})).rejects.toThrow("query must be a string");
  await expect(raw({ query: "x", limit: "5" })).rejects.toThrow("limit must be an integer");
  await expect(raw({ query: "x", role: 1 })).rejects.toThrow("role must be a string");
});

test("session_search reports each source it searches with the total, and stops when the call is cancelled", async () => {
  for (const name of ["a.jsonl", "b.jsonl", "c.jsonl"]) transcript(name, turn("user", "nothing here"));
  const updates: Array<{ message: string; progress?: number; total?: number }> = [];
  const signal = new AbortController().signal;
  await sessionSearch.call({ project_path: project, query: "absent" }, { signal, progress: (update) => updates.push(update) });
  expect(updates.map(({ progress, total }) => [progress, total])).toEqual([[0, 3], [1, 3], [2, 3]]);
  expect(updates.map(({ message }) => message.replace(/Searching \S+, /, ""))).toEqual(["1 of 3", "2 of 3", "3 of 3"]);

  const cancelled = { signal: AbortSignal.abort(), progress: () => {} };
  await expect(sessionSearch.call({ project_path: project, query: "absent" }, cancelled)).rejects.toThrow();
});
