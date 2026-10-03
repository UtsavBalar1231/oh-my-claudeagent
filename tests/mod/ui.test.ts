import type { On, RenderElement, RenderSurface } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { glyphs } from "../../src/core/ui-kit.ts";
import { chip, type Paint } from "../../src/core/visual.ts";
import { Bar, Card, Chip, CodeBlock, Field, HoverCard, type Kit, kitOf, Row, Rule } from "../../hooks/ui.ts";
import { PLUGIN } from "./world.ts";

type ColorOf<C, Prop extends string> = C extends (props: infer P) => unknown ? (P extends { [K in Prop]?: infer V } ? V : never) : never;
type HoverOf<C> = C extends (props: infer P) => unknown ? (P extends { hover?: infer H } ? NonNullable<H> : never) : never;
type TakesRaw<V> = "red" extends V ? true : string extends V ? true : false;

const RAW_ACCEPTED = [
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
  on("ui.render", { component: "Pane", requestId: "gallery" }, (engine, e) => draw(kitOf(engine.ui.resolve(e), e.surface)));
  return async (next: Draw, surface: RenderSurface = "terminal") => {
    draw = next;
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

test("no color prop of the kit or a component takes a raw color string", () => {
  expect(RAW_ACCEPTED).toEqual([false, false, false, false, false, false, false, false]);
});

test("a chip is one bold inverse-text run on its tone", async ($, on) => {
  const drawn = gallery($, on);
  expect(await drawn((kit) => Chip(kit, "PROVEN", "ok", false))).toEqual(
    text({ wrap: "truncate-end" }, text({ color: "inverseText", backgroundColor: "success", bold: true }, " PROVEN ")),
  );
  expect(await drawn((kit) => Chip(kit, "exit 1", "fail", true))).toEqual(
    text({ wrap: "truncate-end" }, text({ color: "inverseText", backgroundColor: "error", bold: true }, "[exit 1]")),
  );
});

test("a bar and a rule draw their pieces as runs of one line", async ($, on) => {
  const drawn = gallery($, on);
  expect(await drawn((kit) => Bar(kit, { done: 3, todo: 4 }, 8, false))).toEqual(
    text(
      { wrap: "truncate-end" },
      text({ color: "success" }, "███"),
      text({ color: "success", backgroundColor: "rate_limit_empty" }, "▍"),
      text({ color: "rate_limit_empty" }, "████"),
    ),
  );
  expect(await drawn((kit) => Rule(kit, 16, glyphs(true), true, "Tasks", { done: 1, total: 2 }))).toEqual(
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
  expect(await drawn((kit) => Card(kit, { key: "c", title: "Task 43", tone: "active", isRaised: true, width: 40, children: body(kit) }))).toEqual({
    type: "Box",
    props: { key: "c", flexDirection: "column", borderStyle: "round", borderColor: "claude", paddingX: 1, width: 40, backgroundColor: "userMessageBackground" },
    children: [text({ bold: true, color: "text", wrap: "truncate-end" }, "Task 43"), text({}, "Done when: just ci exits 0")],
  });
  expect(await drawn((kit) => Card(kit, { key: "c", title: "Plan", tone: "planMode", children: [] }))).toEqual({
    type: "Box",
    props: { key: "c", flexDirection: "column", borderStyle: "round", borderColor: "planMode", paddingX: 1 },
    children: [text({ bold: true, color: "text", wrap: "truncate-end" }, "Plan")],
  });
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

test("a hover card sits absolutely under its anchor, hidden until the pointer is on it", async ($, on) => {
  const drawn = gallery($, on);
  expect(
    await drawn((kit) =>
      HoverCard(kit, {
        key: "h",
        anchor: [kit.Text({ children: ["◐ 43 Record the final verification"] })],
        title: "Task 43",
        tone: "active",
        lines: [kit.Text({ children: ["3 proving entries"] })],
      }),
    ),
  ).toEqual(
    box(
      { key: "h", flexDirection: "column" },
      text({}, "◐ 43 Record the final verification"),
      box(
        {
          position: "absolute",
          top: 1,
          left: 2,
          display: "none",
          hover: { display: "flex" },
          flexDirection: "column",
          borderStyle: "round",
          borderColor: "claude",
          backgroundColor: "userMessageBackground",
          paddingX: 1,
        },
        text({ bold: true, color: "text", wrap: "truncate-end" }, "Task 43"),
        text({}, "3 proving entries"),
      ),
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
