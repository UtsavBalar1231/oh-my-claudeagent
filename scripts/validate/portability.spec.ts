import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fixture, runNamed } from "./fixture.ts";
import { checks } from "./portability.ts";

afterEach(cleanup);

const skill = (body: string) => `---\nname: demo\ndescription: d\n---\n${body}\n`;
const run = (path: string, content: string) => runNamed(checks, "shell portability", fixture({ [path]: content }));

describe("shell portability", () => {
  test("a tree with portable commands passes", async () => {
    const body = ["```bash", 'bun "${CLAUDE_PLUGIN_ROOT}/scripts/run.ts" --yes', "```", "Read `${CLAUDE_PLUGIN_ROOT}/agents/demo.md` first."].join("\n");
    expect(await run("skills/demo/SKILL.md", skill(body))).toMatchObject({ status: "pass" });
  });

  test("sha256sum in a command block fails and names the file and line", async () => {
    expect(await run("skills/demo/SKILL.md", skill('```bash\nsha256sum "plan.md"\n```'))).toEqual({
      status: "fail",
      detail: "skills/demo/SKILL.md:6 uses sha256sum in a code block",
    });
  });

  test("a /tmp path fails in a fenced block, in an inline span and as a ${TMPDIR:-/tmp} fallback", async () => {
    const fenced = await run("agents/demo.md", skill("```bash\nmkdir -p /tmp/scratch\n```"));
    expect(fenced).toEqual({ status: "fail", detail: "agents/demo.md:6 uses a /tmp path in a code block" });
    const inline = await run("agents/demo.md", skill("Clone into `/tmp/opencode/name`."));
    expect(inline).toEqual({ status: "fail", detail: "agents/demo.md:5 uses a /tmp path in a code block" });
    const fallback = await run("templates/demo.md", skill("```bash\ngh repo clone o/r ${TMPDIR:-/tmp}/name\n```"));
    expect(fallback).toEqual({ status: "fail", detail: "templates/demo.md:6 uses a /tmp path in a code block" });
  });

  test("an unquoted ${CLAUDE_PLUGIN_ROOT} command argument fails, in a block and in an inline span", async () => {
    const block = await run("skills/demo/SKILL.md", skill("```bash\nbun ${CLAUDE_PLUGIN_ROOT}/scripts/run.ts --yes\n```"));
    expect(block).toEqual({ status: "fail", detail: "skills/demo/SKILL.md:6 uses an unquoted ${CLAUDE_PLUGIN_ROOT} path in a code block" });
    const inline = await run("output-styles/demo.md", skill("Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/run.ts`."));
    expect(inline).toEqual({ status: "fail", detail: "output-styles/demo.md:5 uses an unquoted ${CLAUDE_PLUGIN_ROOT} path in a code block" });
  });

  test("a quoted ${CLAUDE_PLUGIN_ROOT} passes in double and single quotes", async () => {
    const body = ["```bash", 'bun "${CLAUDE_PLUGIN_ROOT}/a.ts"', "bun '${CLAUDE_PLUGIN_ROOT}/b.ts'", 'FOO="x ${CLAUDE_PLUGIN_ROOT}/c"', "```"].join("\n");
    expect(await run("skills/demo/SKILL.md", skill(body))).toMatchObject({ status: "pass" });
  });

  test("prose outside code and frontmatter is not scanned", async () => {
    const content = '---\nname: demo\ndescription: "uses `sha256sum` and /tmp/x"\n---\nOld hosts had sha256sum under /tmp/x.\n';
    expect(await run("skills/demo/SKILL.md", content)).toMatchObject({ status: "pass" });
  });

  test("a fence of tildes and a longer fence are tracked to their own close", async () => {
    const body = ["````text", "```", "sha256sum x", "```", "````", "~~~", "/tmp/y", "~~~"].join("\n");
    const result = await run("skills/demo/SKILL.md", skill(body));
    expect(result).toEqual({
      status: "fail",
      detail: "skills/demo/SKILL.md:7 uses sha256sum in a code block; skills/demo/SKILL.md:11 uses a /tmp path in a code block",
    });
  });

  test("every shipped surface is scanned and a source file is not", async () => {
    for (const path of ["agents/demo.md", "skills/demo/SKILL.md", "skills/demo/references/notes.md", "output-styles/demo.md", "templates/demo.md"]) {
      expect(await run(path, skill("`sha256sum x`"))).toMatchObject({ status: "fail" });
    }
    expect(await run("docs/demo.md", skill("`sha256sum x`"))).toMatchObject({ status: "pass" });
  });
});
