import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BARE_TARGET, FORBIDDEN, PHRASES, applyOverlay, dropSections, generate, listSources, parseModelRef, prepare, splitFrontmatter, stripSource } from "./lib.ts";

const root = join(import.meta.dir, "..");
const data = generate(root);
const agent = (id: string) => data.agents.find((a) => a.id === id)!;
const skill = (id: string) => data.skills.find((s) => s.id === id)!;

const texts: [string, string][] = [
  ...data.agents.flatMap((a): [string, string][] => [[`${a.id} description`, String(a.description)], [`${a.id} system`, String(a.system)]]),
  ...data.skills.flatMap((s): [string, string][] => [[`${s.id} description`, String(s.description)], [`${s.id} content`, String(s.content)]]),
  ...data.commands.flatMap((c): [string, string][] => [[`${c.name} description`, String(c.description)], [`${c.name} template`, String(c.template)]]),
  ["outputStyle", data.outputStyle],
];

function hits(text: string, pattern: string | RegExp): string[] {
  return text.split("\n").filter((line) => (typeof pattern === "string" ? line.includes(pattern) : pattern.test(line)));
}

describe("generated omca.json", () => {
  test("is fresh", () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dir, "generated/omca.json"), "utf8"));
    expect(data, "generated/omca.json is stale: run bun run generate").toEqual(committed);
  });

  test("has no forbidden tokens", () => {
    const found = texts.flatMap(([where, text]) => FORBIDDEN.flatMap((p) => hits(text, p).map((line) => `${where} [${p}]: ${line}`)));
    expect(found).toEqual([]);
  });

  test("has no doubled article from the agent-name rewrites", () => {
    const found = texts.flatMap(([where, text]) => hits(text, /\bthe the\b/i).map((line) => `${where}: ${line}`));
    expect(found).toEqual([]);
  });

  test("has no bare delegation targets", () => {
    const found = texts.flatMap(([where, text]) => hits(text, BARE_TARGET).map((line) => `${where}: ${line}`));
    expect(found).toEqual([]);
  });

  test("every phrase entry matches at least one source after overlays", () => {
    const prepared = listSources().map((src) => {
      const { data: fm, text } = prepare(root, src);
      return `${typeof fm.description === "string" ? fm.description : ""}\n${text}`;
    });
    const unmatched = PHRASES.map(([from]) => from).filter((from) => !prepared.some((t) => t.includes(from)));
    expect(unmatched).toEqual([]);
  });

  test("every overlay heading exists in its source", () => {
    const sources = listSources();
    for (const file of readdirSync(join(import.meta.dir, "overlays"))) {
      const src = sources.find((s) => `${s.overlay}.md` === file);
      expect(src, `${file} has no source`).toBeDefined();
      const { body } = splitFrontmatter(readFileSync(join(root, src!.relPath), "utf8"), src!.relPath);
      const { missing } = applyOverlay(stripSource(body), readFileSync(join(import.meta.dir, "overlays", file), "utf8"));
      expect(missing, file).toEqual([]);
    }
  });

  test("agent fields", () => {
    const explore = agent("omca-explore");
    expect(explore.steps).toBe(30);
    expect(explore.deny).toEqual(["edit", "subagent"]);
    expect(explore.color).toBe("#3b82f6");
    expect(explore.tier).toBe("opus");
    expect(agent("omca-oracle").tier).toBe("fable");
  });

  test("skill fields", () => {
    expect(skill("omca-handoff").name).toBe("omca-handoff");
    expect(skill("omca-handoff").autoinvoke).toBe(false);
    expect("autoinvoke" in skill("omca-debugging")).toBe(false);
  });
});

test("applyOverlay splices with one blank line between blocks", () => {
  const source = "# T\n\n## A\n\nold a\n\n### A1\n\nold a1\n\n## B\n\nb\n";
  const { text, missing } = applyOverlay(source, "## A\n\nnew a\n");
  expect(missing).toEqual([]);
  expect(text).toBe("# T\n\n## A\n\nnew a\n\n## B\n\nb\n");
  expect(applyOverlay(source, "## B\n\nnew b").text).toBe("# T\n\n## A\n\nold a\n\n### A1\n\nold a1\n\n## B\n\nnew b\n");
  expect(applyOverlay(source, "## Z\n\nz\n").missing).toEqual(["## Z"]);
});

test("heading detection toggles on every fence line", () => {
  expect(dropSections("## Keep\n\n```\n## Memory Guidance\n```\n", ["Memory Guidance"])).toContain("## Memory Guidance");
});

test("parseModelRef", () => {
  expect(parseModelRef("anthropic/claude-opus-5-5#high")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" });
  expect("variant" in parseModelRef("anthropic/claude-opus-5-5")!).toBe(false);
  expect(parseModelRef("bad")).toBeUndefined();
  expect(parseModelRef("/x")).toBeUndefined();
  expect(parseModelRef(42)).toBeUndefined();
});

test("package.json version matches plugin.json", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  expect(pkg.version).toBe(plugin.version);
});
