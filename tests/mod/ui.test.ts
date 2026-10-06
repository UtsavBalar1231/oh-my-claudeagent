import type { On, RenderElement, RenderSurface } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { framesOf, rasterCells, svgOf } from "../../src/core/mascots.ts";
import { type GlyphTier, glyphs } from "../../src/core/ui-kit.ts";
import { chip, type Paint } from "../../src/core/visual.ts";
import { Card, CodeBlock, Field, type Kit, kitOf, Row, Rule, rowsAtLeast, ScopedCard } from "../../hooks/ui.ts";
import { PLUGIN } from "./world.ts";

type ColorOf<C, Prop extends string> = C extends (props: infer P) => unknown ? (P extends { [K in Prop]?: infer V } ? V : never) : never;
type HoverOf<C> = C extends (props: infer P) => unknown ? (P extends { hover?: infer H } ? NonNullable<H> : never) : never;
type TakesRaw<V> = "red" extends V ? true : string extends V ? true : false;

// Fails to compile when a color prop of the kit or a component takes a raw color string.
export const RAW_ACCEPTED = [
  false satisfies TakesRaw<ColorOf<Kit["Text"], "color">>,
  false satisfies TakesRaw<ColorOf<Kit["Text"], "backgroundColor">>,
  false satisfies TakesRaw<ColorOf<Kit["Box"], "borderColor">>,
  false satisfies TakesRaw<ColorOf<Kit["Box"], "backgroundColor">>,
  false satisfies TakesRaw<NonNullable<HoverOf<Kit["Box"]>["backgroundColor"]>>,
  false satisfies TakesRaw<NonNullable<HoverOf<Kit["Text"]>["color"]>>,
  false satisfies TakesRaw<NonNullable<HoverOf<Kit["Button"]>["color"]>>,
  false satisfies TakesRaw<Paint>,
];

type Draw = (kit: Kit) => RenderElement;

// A test registers its hooks before its first engine call, so one gallery serves every drawing.
function gallery($: Engine, on: On) {
  let draw: Draw = (kit) => kit.Text({ children: [""] });
  let tier: GlyphTier = "nerd";
  let isStill = false;
  on("ui.render", { component: "Pane", requestId: "gallery" }, (engine, e) => draw(kitOf(engine.ui.resolve(e), e.surface, tier, isStill)));
  return async (next: Draw, surface: RenderSurface = "terminal", glyphTier: GlyphTier = "nerd", still = false) => {
    draw = next;
    tier = glyphTier;
    isStill = still;
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: "Pane",
      requestId: "gallery",
      viewport: { columns: 120, rows: 40 },
      props: { title: "Gallery", isFocused: true, bodyColumns: 56, placement: "dock", scroll: { offset: 0, bodyRows: 36 }, view: {} },
    });
    const tree = await ui.drawn();
    await ui.unmount();
    return tree;
  };
}

// A drawn element carries `hover` beside its props and leaves out empty props.
const element = (type: string) => (props: Record<string, unknown>, ...children: unknown[]) => {
  const { hover, ...rest } = props;
  return { type, ...(Object.keys(rest).length === 0 ? {} : { props: rest }), ...(hover === undefined ? {} : { hover }), children };
};
const text = element("Text");
const box = element("Box");

test("a rule draws its pieces as runs of one line", async ($, on) => {
  const drawn = gallery($, on);
  expect(await drawn((kit) => Rule(kit, 16, glyphs("ascii"), true, "Tasks", { done: 1, total: 2 }))).toEqual(
    text(
      { wrap: "truncate-end" },
      text({ color: "subtle" }, "--"),
      text({}, " "),
      text({ color: "text", bold: true }, "Tasks"),
      text({}, " "),
      text({ color: "subtle" }, "--"),
      text({}, " 1/2 "),
    ),
  );
});

test("a card is a round border in its tone with a bold title, filled when raised", async ($, on) => {
  const drawn = gallery($, on);
  const body = (kit: Kit) => [kit.Text({ children: ["Done when: just ci exits 0"] })];
  expect(await drawn((kit) => Card(kit, { key: "c", title: "Task 43", tone: "active", isAscii: false, isRaised: true, width: 40, children: body(kit) }))).toEqual({
    type: "Box",
    props: { key: "c", flexDirection: "column", borderStyle: "round", borderColor: "claude", paddingX: 1, width: 40, backgroundColor: "userMessageBackground" },
    children: [text({ bold: true, color: "text", wrap: "truncate-end" }, "Task 43"), text({}, "Done when: just ci exits 0")],
  });
  expect(await drawn((kit) => Card(kit, { key: "c", title: "Plan", tone: "planMode", isAscii: false, children: [] }))).toEqual({
    type: "Box",
    props: { key: "c", flexDirection: "column", borderStyle: "round", borderColor: "planMode", paddingX: 1 },
    children: [text({ bold: true, color: "text", wrap: "truncate-end" }, "Plan")],
  });
});

test("in ASCII mode every card draws the engine's classic border", async ($, on) => {
  const drawn = gallery($, on);
  const lines = (kit: Kit) => [kit.Text({ children: ["3 proving entries"] })];
  const classic = { props: { borderStyle: "classic" } };
  expect(await drawn((kit) => Card(kit, { key: "c", title: "Plan", tone: "plan", isAscii: true, children: [] }))).toMatchObject(classic);
  expect(
    await drawn((kit) => ScopedCard(kit, { key: "s", scope: "lane", title: "executor", tone: "plan", isAscii: true, lines: lines(kit), top: 0, left: 2, width: 30 })),
  ).toMatchObject(classic);
});

test("a tree's fewest rows: one per text or markdown, code by line, a border two, a row its tallest, nothing out of the flow", async ($, on) => {
  const drawn = gallery($, on);
  const tree = await drawn((kit) =>
    kit.Box({
      flexDirection: "column",
      children: [
        Card(kit, { key: "c", title: "Learnings", tone: "info", isAscii: false, children: [kit.Markdown({ text: "a long paragraph" }), kit.Markdown({ text: " " })] }),
        kit.Box({ flexDirection: "row", children: [kit.Text({ children: ["a"] }), kit.Box({ flexDirection: "column", children: [kit.Text({ children: ["b"] }), kit.Text({ children: ["c"] })] })] }),
        CodeBlock(kit, { source: "one\ntwo" }),
        kit.Box({ position: "absolute", top: 0, children: [kit.Text({ children: ["over"] })] }),
        kit.Text({ children: [""] }),
      ],
    }),
  );
  expect(rowsAtLeast(tree)).toBe(4 + 2 + 2);
});

test("a row lights selectionBg on hover, holds it bold when focused, and dims when done; a chip keeps its colors", async ($, on) => {
  const drawn = gallery($, on);
  const pieces = [{ text: "✓ ", color: "success" as const }, { text: "42 Port tabs " }, chip("PROVEN", "ok", false)];
  const proven = text({ color: "inverseText", backgroundColor: "success", bold: true }, " PROVEN ");
  const row = (...children: unknown[]) =>
    box({ key: "r", flexDirection: "row", hover: { backgroundColor: "selectionBg" } }, text({ wrap: "truncate-end" }, ...children));

  expect(await drawn((kit) => Row(kit, { key: "r", pieces }))).toEqual(
    row(text({ color: "success", hover: { color: "text" } }, "✓ "), text({ hover: { color: "text" } }, "42 Port tabs "), proven),
  );
  expect(await drawn((kit) => Row(kit, { key: "r", pieces, isDone: true }))).toEqual(
    row(text({ color: "inactive", hover: { color: "text" } }, "✓ "), text({ color: "inactive", hover: { color: "text" } }, "42 Port tabs "), proven),
  );
  const focused = await drawn((kit) => Row(kit, { key: "r", pieces, isFocused: true, isDone: true }));
  expect(focused).toEqual(
    box(
      { key: "r", flexDirection: "row", hover: { backgroundColor: "selectionBg" }, backgroundColor: "selectionBg" },
      text({ wrap: "truncate-end" }, text({ color: "text", bold: true }, "✓ "), text({ color: "text", bold: true }, "42 Port tabs "), proven),
    ),
  );
});

test("code is highlighted by language, and drawn as a diff only when its hunk counts hold", async ($, on) => {
  const drawn = gallery($, on);
  const diff = "@@ -1,2 +1,2 @@\n a\n-b\n+c";
  const broken = "@@ -1,4 +1,5 @@\n a\n-b\n+c";
  expect(await drawn((kit) => CodeBlock(kit, { source: "just ci", language: "bash" }))).toEqual({
    type: "Code",
    props: { source: "just ci", language: "bash" },
  });
  expect(await drawn((kit) => CodeBlock(kit, { source: diff, isDiff: true }))).toEqual({
    type: "Code",
    props: { source: diff, format: "diff" },
  });
  expect(await drawn((kit) => CodeBlock(kit, { source: broken, language: "diff", isDiff: true }))).toEqual({
    type: "Code",
    props: { source: broken, language: "diff" },
  });
});

test("a field is an Input where the surface has one and its value as text on mobile", async ($, on) => {
  const drawn = gallery($, on);
  const spec = { key: "find", label: "/ ", placeholder: "filter tasks", value: "", onSubmit: () => undefined };
  expect(await drawn((kit) => Field(kit, spec))).toEqual({
    type: "Input",
    props: { key: "find", label: "/ ", placeholder: "filter tasks", value: "" },
    press: expect.anything(),
  });
  expect(await drawn((kit) => Field(kit, spec), "mobile")).toEqual(
    text({ wrap: "truncate-end" }, "/ ", text({ dimColor: true }, "filter tasks")),
  );
  expect(await drawn((kit) => Field(kit, { ...spec, value: "43" }), "mobile")).toEqual(text({ wrap: "truncate-end" }, "/ ", "43"));
});

const MASCOT_STATES = ["working", "done", "failed", "idle"] as const;
const mascotOrNothing = (type: string, state: (typeof MASCOT_STATES)[number], frame: number) => (kit: Kit) =>
  kit.mascot(type, state, "m", frame) ?? kit.Text({ children: ["none"] });

test("a terminal mascot is a 16 by 8 Raster of the frame index wrapped to the state's frames, the first frame when not working", async ($, on) => {
  const drawn = gallery($, on);
  const raster = (cells: string) => ({ type: "Raster", props: { key: "m", columns: 16, rows: 8, cells } });
  for (const state of MASCOT_STATES) {
    const frames = framesOf("executor", state);
    const moves = state === "working";
    expect(await drawn(mascotOrNothing("oh-my-claudeagent:executor", state, 0))).toMatchObject(raster(rasterCells(frames[0]!)));
    expect(await drawn(mascotOrNothing("executor", state, frames.length + 1))).toMatchObject(raster(rasterCells(frames[moves ? 1 : 0]!)));
    expect(await drawn(mascotOrNothing("executor", state, 1))).toMatchObject(raster(rasterCells(frames[moves ? 1 : 0]!)));
  }
});

test("a remote mascot is an Svg with its alt, interactive only while working, and the same props for every frame", async ($, on) => {
  const drawn = gallery($, on);
  for (const surface of ["desktop", "mobile", "vscode"] as const) {
    for (const state of MASCOT_STATES) {
      const frames = framesOf("planner", state);
      const moves = state === "working";
      const props = { source: svgOf(moves ? frames : [frames[0]!]), alt: `planner ${state}`, width: 64, height: 64, ...(moves ? { isInteractive: true } : {}) };
      const first = await drawn(mascotOrNothing("planner", state, 0), surface);
      expect(first).toMatchObject({ type: "Svg", props });
      expect(Object.keys((first as { props: object }).props)).toEqual(Object.keys(props));
      const later = await drawn(mascotOrNothing("planner", state, 7), surface);
      expect(JSON.stringify(later)).toBe(JSON.stringify(first));
    }
  }
});

test("a still kit draws a working mascot as frame 0 on the terminal and as a one-frame Svg without isInteractive elsewhere", async ($, on) => {
  const drawn = gallery($, on);
  const frames = framesOf("executor", "working");
  expect(await drawn(mascotOrNothing("executor", "working", 3), "terminal", "nerd", true)).toMatchObject({ type: "Raster", props: { cells: rasterCells(frames[0]!) } });
  const svg = (await drawn(mascotOrNothing("executor", "working", 3), "desktop", "nerd", true)) as { props: Record<string, unknown> };
  expect(svg.props["source"]).toBe(svgOf([frames[0]!]));
  expect("isInteractive" in svg.props).toBe(false);
});

test("a mascot draws nothing for an unknown agent or the ASCII tier", async ($, on) => {
  const drawn = gallery($, on);
  const mascot = (type: string) => mascotOrNothing(type, "working", 0);
  expect(await drawn(mascot("nobody"))).toEqual(text({}, "none"));
  expect(await drawn(mascot("executor"), "terminal", "ascii")).toEqual(text({}, "none"));
  expect(await drawn(mascot("executor"), "desktop", "ascii")).toEqual(text({}, "none"));
});

test("a Raster counts as its own rows", async ($, on) => {
  const drawn = gallery($, on);
  const tree = await drawn((kit) => kit.Box({ flexDirection: "row", children: [kit.mascot("executor", "idle", "m", 0) ?? kit.Text({ children: [""] }), kit.Text({ children: ["name"] })] }));
  expect(rowsAtLeast(tree)).toBe(8);
});
