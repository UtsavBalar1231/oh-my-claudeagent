import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools } from "./notepad.ts";

const NOTEPAD_MODULE = join(import.meta.dir, "notepad.ts");
const SERVER = join(import.meta.dir, "..", "omca.ts");
const SECTIONS = ["learnings", "issues", "decisions", "problems"];
const STAMP = "2026-10-02T12:00:00Z";
const entry = (content: string) => `\n## ${STAMP}\n\n${content}\n`;
const INVALID_PLAN = (plan: string) => `plan_name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$; got ${JSON.stringify(plan)}`;

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "omca-notepad-")));
  expect(Bun.spawnSync(["git", "init", "-q", project]).exitCode).toBe(0);
});

afterEach(() => {
  setSystemTime();
  rmSync(project, { recursive: true, force: true });
});

const tool = (name: string) => {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
};
const call = async (name: string, args: Record<string, unknown>) => tool(name).call({ working_directory: project, ...args });
const write = (plan_name: string, section: string, content: string) => call("notepad_write", { plan_name, section, content });
const sectionPath = (plan: string, section: string) => join(project, ".omca", "notepads", plan, `${section}.md`);
const readSection = (plan: string, section: string) => readFileSync(sectionPath(plan, section), "utf8");

describe("declarations", () => {
  test("the four notepad tools are declared with the contract's annotations", () => {
    expect(tools.map(({ name, annotations }) => ({ name, annotations }))).toEqual([
      {
        name: "notepad_write",
        annotations: { title: "Append to notepad", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      { name: "notepad_read", annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
      { name: "notepad_list", annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
      {
        name: "notepad_compact",
        annotations: { title: "Compact notepad section", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
    ]);
  });

  test("descriptions fit the client cap and property names meet the naming rule", () => {
    for (const { name, description, inputSchema } of tools) {
      expect(description.length, name).toBeGreaterThan(0);
      expect(description.length, name).toBeLessThanOrEqual(2048);
      for (const property of Object.keys(inputSchema.properties)) expect(property, name).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    }
  });

  test("required arguments and the section enum are exact", () => {
    expect(tools.map(({ name, inputSchema }) => [name, inputSchema.required ?? []])).toEqual([
      ["notepad_write", ["plan_name", "section", "content"]],
      ["notepad_read", ["plan_name"]],
      ["notepad_list", []],
      ["notepad_compact", ["plan_name", "section"]],
    ]);
    const enums = (name: string) => JSON.stringify(tool(name).inputSchema.properties.section);
    for (const name of ["notepad_write", "notepad_compact"]) expect(enums(name)).toContain(JSON.stringify(SECTIONS));
    expect(enums("notepad_read")).toContain(JSON.stringify(SECTIONS));
  });
});

describe("notepad tools", () => {
  beforeEach(() => setSystemTime(new Date("2026-10-02T12:00:00.789Z")));

  describe("notepad_write", () => {
    test("notepad_write creates a section file at .omca/notepads/{plan}/{section}.md", async () => {
      const result = await write("my-plan", "learnings", "First learning");
      expect(result).toBe("Appended to my-plan/learnings.md");
      expect(readSection("my-plan", "learnings")).toBe(entry("First learning"));
    });

    test("notepad_write appends, so both entries are present after two writes", async () => {
      await write("append-plan", "issues", "Entry one");
      await write("append-plan", "issues", "Entry two");
      expect(readSection("append-plan", "issues")).toBe(entry("Entry one") + entry("Entry two"));
    });

    test("notepad_write accepts every declared section", async () => {
      for (const section of SECTIONS) {
        await write("accept-plan", section, `entry for ${section}`);
        expect(readSection("accept-plan", section)).toBe(entry(`entry for ${section}`));
      }
    });

    for (const section of ["questions", "notes", ""]) {
      test(`notepad_write rejects the unknown section "${section}" and creates nothing`, async () => {
        await expect(write("reject-plan", section, "should not land")).rejects.toThrow(
          `section must be one of learnings, issues, decisions, problems; got ${JSON.stringify(section)}`,
        );
        expect(existsSync(join(project, ".omca", "notepads"))).toBe(false);
      });
    }

    test("notepad_write names a missing or non-string argument", async () => {
      await expect(call("notepad_write", { section: "issues", content: "x" })).rejects.toThrow("plan_name must be a string");
      await expect(call("notepad_write", { plan_name: "p", content: "x" })).rejects.toThrow("section must be one of");
      await expect(call("notepad_write", { plan_name: "p", section: "issues" })).rejects.toThrow("content must be a string");
      await expect(call("notepad_write", { plan_name: "p", section: "issues", content: 7 })).rejects.toThrow("content must be a string");
      await expect(call("notepad_write", { plan_name: "p", section: "issues", content: "x", working_directory: 3 })).rejects.toThrow(
        "working_directory must be a string",
      );
      expect(existsSync(join(project, ".omca", "notepads"))).toBe(false);
    });

    test("notepad_write drops the timestamp's milliseconds and keeps empty content as an empty entry", async () => {
      await write("p", "issues", "");
      expect(readSection("p", "issues")).toBe(`\n## ${STAMP}\n\n\n`);
    });

    test("notepad_write resolves a subdirectory to the git root and drops the .omca gitignore there", async () => {
      const nested = join(project, "sub", "dir");
      mkdirSync(nested, { recursive: true });
      await call("notepad_write", { plan_name: "p", section: "issues", content: "from below", working_directory: nested });
      expect(readSection("p", "issues")).toBe(entry("from below"));
      expect(readFileSync(join(project, ".omca", ".gitignore"), "utf8")).toBe("*\n!/rules/\n");
    });

    test("notepad_write leaves only the section file behind, with no lock or temp file", async () => {
      await write("clean-plan", "issues", "one");
      await write("clean-plan", "issues", "two");
      expect(readdirSync(join(project, ".omca", "notepads", "clean-plan"))).toEqual(["issues.md"]);
    });

    test("notepad_write warns past 50 KiB, counting bytes of the whole file", async () => {
      const overhead = Buffer.byteLength(entry(""));
      expect(await write("big", "issues", "x".repeat(50 * 1024 - overhead))).toBe("Appended to big/issues.md");
      expect(await write("big", "problems", "x".repeat(50 * 1024 - overhead + 1))).toBe(
        "Appended to big/problems.md\n[WARNING: section file is 50KB — consider running notepad_compact to reduce size]",
      );
      expect(await write("big", "learnings", "é".repeat(30_000))).toBe(
        "Appended to big/learnings.md\n[WARNING: section file is 58KB — consider running notepad_compact to reduce size]",
      );
    });
  });

  describe("plan_name validation", () => {
    const bad = ["", "../escape", "a/b", "/abs", ".hidden", "..", "-lead", "with space", "x".repeat(129), "tab\t"];

    for (const plan of bad) {
      test(`every tool rejects the plan name ${JSON.stringify(plan.length > 20 ? `${plan.slice(0, 8)}...(${plan.length})` : plan)} before touching a path`, async () => {
        const message = INVALID_PLAN(plan);
        await expect(write(plan, "issues", "x")).rejects.toThrow(message);
        await expect(call("notepad_read", { plan_name: plan })).rejects.toThrow(message);
        await expect(call("notepad_compact", { plan_name: plan, section: "issues" })).rejects.toThrow(message);
        if (plan !== "") await expect(call("notepad_list", { plan_name: plan })).rejects.toThrow(message);
        expect(existsSync(join(project, ".omca", "notepads"))).toBe(false);
        expect(existsSync(join(project, ".omca", "escape"))).toBe(false);
      });
    }

    test("real plan names with dots, underscores, capitals and the 128-character limit are accepted", async () => {
      for (const plan of ["platform-2.1.278-reconciliation", "sync-claude-code-v2.1.197", "Plan_1", "a", "x".repeat(128)]) {
        expect(await write(plan, "issues", "ok")).toBe(`Appended to ${plan}/issues.md`);
      }
    });
  });

  describe("notepad_read", () => {
    test("notepad_read returns the section's content under a titled heading", async () => {
      await write("read-plan", "decisions", "Use pytest");
      expect(await call("notepad_read", { plan_name: "read-plan", section: "decisions" })).toBe(`# Decisions\n\n${entry("Use pytest")}`);
    });

    test("notepad_read returns a not-found message for a missing plan", async () => {
      expect(await call("notepad_read", { plan_name: "nonexistent-plan", section: "learnings" })).toBe(
        "No notepad found for plan: nonexistent-plan",
      );
    });

    test("notepad_read with no section returns all written sections in canonical order, separated by a rule", async () => {
      await write("multi-plan", "problems", "Problem B");
      await write("multi-plan", "learnings", "Learning A");
      const expected = `# Learnings\n\n${entry("Learning A")}\n---\n\n# Problems\n\n${entry("Problem B")}`;
      expect(await call("notepad_read", { plan_name: "multi-plan" })).toBe(expected);
      expect(await call("notepad_read", { plan_name: "multi-plan", section: null })).toBe(expected);
    });

    test("notepad_read says the notepad has no entries when the plan exists but the section does not", async () => {
      await write("half-plan", "issues", "only issues");
      expect(await call("notepad_read", { plan_name: "half-plan", section: "learnings" })).toBe("No notepad entries found for plan: half-plan");
      mkdirSync(join(project, ".omca", "notepads", "bare-plan"), { recursive: true });
      expect(await call("notepad_read", { plan_name: "bare-plan" })).toBe("No notepad entries found for plan: bare-plan");
    });

    test("notepad_read rejects an unknown section", async () => {
      await expect(call("notepad_read", { plan_name: "p", section: "notes" })).rejects.toThrow('section must be one of learnings, issues, decisions, problems; got "notes"');
    });
  });

  describe("notepad_list", () => {
    test("notepad_list returns the section names for an existing plan, sorted", async () => {
      await write("list-plan", "decisions", "D1");
      await write("list-plan", "issues", "I1");
      expect(await call("notepad_list", { plan_name: "list-plan" })).toBe("Plan: list-plan\nSections: decisions, issues");
    });

    test("notepad_list reports a missing plan and an empty project", async () => {
      expect(await call("notepad_list", { plan_name: "ghost-plan" })).toBe("No notepad found for plan: ghost-plan");
      expect(await call("notepad_list", {})).toBe("No notepads found.");
      mkdirSync(join(project, ".omca", "notepads"), { recursive: true });
      expect(await call("notepad_list", {})).toBe("No notepads found.");
      expect(await call("notepad_list", { plan_name: "ghost-plan" })).toBe("No notepad found for plan: ghost-plan");
    });

    test("notepad_list names a plan with no section files as empty", async () => {
      mkdirSync(join(project, ".omca", "notepads", "hollow"), { recursive: true });
      expect(await call("notepad_list", { plan_name: "hollow" })).toBe("Plan: hollow\nSections: empty");
    });

    test("notepad_list with no plan name lists every plan, sorted, and skips files that are not sections", async () => {
      await write("beta", "problems", "b");
      await write("alpha", "learnings", "a1");
      await write("alpha", "issues", "a2");
      mkdirSync(join(project, ".omca", "notepads", "empty-plan"));
      writeFileSync(join(project, ".omca", "notepads", "alpha", "notes.txt"), "not a section");
      writeFileSync(join(project, ".omca", "notepads", "stray-file"), "not a plan");
      expect(await call("notepad_list", {})).toBe(
        "Available notepads:\n\n- alpha: issues, learnings\n- beta: problems\n- empty-plan: empty",
      );
    });
  });

  describe("notepad_compact", () => {
    test("notepad_compact reports no compaction needed for a short section and leaves it untouched", async () => {
      await write("compact-plan", "learnings", "Short content");
      expect(await call("notepad_compact", { plan_name: "compact-plan", section: "learnings" })).toBe(
        "Section 'learnings' has 3 lines — no compaction needed",
      );
      expect(readSection("compact-plan", "learnings")).toBe(entry("Short content"));
    });

    test("notepad_compact keeps the last 20 lines under a marker when the section is larger", async () => {
      for (let i = 0; i < 25; i++) await write("big-plan", "learnings", `Entry ${i}`);
      expect(await call("notepad_compact", { plan_name: "big-plan", section: "learnings" })).toBe(
        "Compacted 'learnings': removed 79 old lines, kept last 20",
      );
      const kept = [20, 21, 22, 23, 24].map((i) => `\n## ${STAMP}\n\nEntry ${i}`).join("\n");
      expect(readSection("big-plan", "learnings")).toBe(`[Compacted: 79 earlier lines removed]\n${kept}\n`);
      expect(readdirSync(join(project, ".omca", "notepads", "big-plan"))).toEqual(["learnings.md"]);
    });

    test("notepad_compact cuts by line at the boundary: 20 lines stay, 21 lose one", async () => {
      const lines = (count: number) => Array.from({ length: count }, (_, i) => `l${i + 1}`);
      mkdirSync(join(project, ".omca", "notepads", "edge"), { recursive: true });
      writeFileSync(sectionPath("edge", "issues"), `\n  ${lines(20).join("\n")}\n\n`);
      expect(await call("notepad_compact", { plan_name: "edge", section: "issues" })).toBe(
        "Section 'issues' has 20 lines — no compaction needed",
      );
      writeFileSync(sectionPath("edge", "issues"), `${lines(21).join("\n")}\n`);
      expect(await call("notepad_compact", { plan_name: "edge", section: "issues" })).toBe(
        "Compacted 'issues': removed 1 old lines, kept last 20",
      );
      expect(readSection("edge", "issues")).toBe(`[Compacted: 1 earlier lines removed]\n${lines(21).slice(1).join("\n")}\n`);
    });

    test("notepad_compact reports a missing section without creating the plan", async () => {
      expect(await call("notepad_compact", { plan_name: "ghost", section: "learnings" })).toBe("Section 'learnings' not found for plan 'ghost'");
      expect(existsSync(join(project, ".omca", "notepads"))).toBe(false);
    });

    test("notepad_compact rejects an unknown section", async () => {
      await expect(call("notepad_compact", { plan_name: "p", section: "notes" })).rejects.toThrow(
        'section must be one of learnings, issues, decisions, problems; got "notes"',
      );
    });
  });
});

describe("concurrent appends", () => {
  const appender = `import { tools } from ${JSON.stringify(NOTEPAD_MODULE)};
const [label, count] = process.argv.slice(2);
const write = tools.find((tool) => tool.name === "notepad_write");
await Promise.all(
  Array.from({ length: Number(count) }, (_, i) =>
    write.call({ plan_name: "shared", section: "learnings", content: label + "-" + i }),
  ),
);
`;

  test("notepad_write from six processes, twenty concurrent calls each, loses no line", async () => {
    const script = join(project, "append.ts");
    writeFileSync(script, appender);
    const children = Array.from({ length: 6 }, (_, p) =>
      Bun.spawn([process.execPath, script, `p${p}`, "20"], { cwd: project, stdout: "ignore", stderr: "pipe" }),
    );
    const codes = await Promise.all(children.map((child) => child.exited));
    const stderr = await Promise.all(children.map((child) => new Response(child.stderr).text()));
    expect(stderr.filter(Boolean)).toEqual([]);
    expect(codes).toEqual(Array(6).fill(0));

    const text = readSection("shared", "learnings");
    const expected = Array.from({ length: 6 }, (_, p) => Array.from({ length: 20 }, (_, i) => `p${p}-${i}`)).flat();
    expect(text.split("\n").filter((line) => /^p\d+-\d+$/.test(line)).sort()).toEqual(expected.sort());
    expect(text.match(/^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/gm)).toHaveLength(120);
    expect(text.replace(/\n## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n\np\d+-\d+\n/g, "")).toBe("");
    expect(readdirSync(join(project, ".omca", "notepads", "shared"))).toEqual(["learnings.md"]);
  }, 60_000);
});

describe("through the server", () => {
  type Reply = { id: number; result?: { content: Array<{ type: string; text: string }>; isError?: boolean; resultType: string; tools?: unknown[] } };

  async function withServer(run: (request: (method: string, params?: Record<string, unknown>) => Promise<Reply>) => Promise<void>) {
    const env = { ...process.env };
    delete env.OMCA_SERVER_ROLE;
    const proc = Bun.spawn([process.execPath, SERVER], { cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let nextId = 1;
    const request = async (method: string, params?: Record<string, unknown>): Promise<Reply> => {
      const id = nextId++;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      proc.stdin.flush();
      while (!buffer.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the server closed stdout");
        buffer += decoder.decode(value, { stream: true });
      }
      const newline = buffer.indexOf("\n");
      const reply: Reply = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      expect(reply.id).toBe(id);
      return reply;
    };
    try {
      await run(request);
    } finally {
      proc.kill("SIGKILL");
    }
  }

  test("a server without the hooks role lists the declared notepad tools and serves them end to end", async () => {
    await withServer(async (request) => {
      const listed = (await request("tools/list")).result?.tools ?? [];
      const declared = tools.map(({ call, ...declaration }) => declaration);
      expect(JSON.parse(JSON.stringify(listed)).filter((t: { name: string }) => t.name.startsWith("notepad_"))).toEqual(
        JSON.parse(JSON.stringify(declared)),
      );

      const written = await request("tools/call", { name: "notepad_write", arguments: { plan_name: "e2e", section: "issues", content: "via server" } });
      expect(written.result).toEqual({ content: [{ type: "text", text: "Appended to e2e/issues.md" }], resultType: "complete" });
      const read = await request("tools/call", { name: "notepad_read", arguments: { plan_name: "e2e" } });
      expect(read.result?.content[0]?.text).toMatch(/^# Issues\n\n\n## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n\nvia server\n$/);

      const rejected = await request("tools/call", { name: "notepad_write", arguments: { plan_name: "../x", section: "issues", content: "no" } });
      expect(rejected.result).toEqual({ content: [{ type: "text", text: INVALID_PLAN("../x") }], isError: true, resultType: "complete" });
      expect(existsSync(join(project, ".omca", "x"))).toBe(false);
    });
  });
});
