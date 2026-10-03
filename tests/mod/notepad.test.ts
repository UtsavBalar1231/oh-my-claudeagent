import type { RenderElement } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { formatWhen, glyphs, usableColumns } from "../../src/core/ui-kit.ts";
import { type Piece, rule } from "../../src/core/visual.ts";
import {
  bodyColumns,
  BOULDER,
  cellsAcross,
  isAscii,
  pane,
  ROOT,
  rows,
  run,
  SESSION,
  type Size,
  SIZES,
  topRows,
  world,
  write,
} from "./world.ts";

const PADS = `${ROOT}/.omca/notepads`;
const LEARNED_AT = Date.UTC(2026, 9, 2, 9, 15, 0);
const LISTED_AT = Date.UTC(2026, 9, 2, 11, 0, 0);
const ISSUE_AT = Date.UTC(2026, 9, 2, 10, 0, 0);
const BOUND = JSON.stringify({ plans: { sample: { active_plan: `${ROOT}/plans/sample.md` }, other: {} }, bindings: { [SESSION]: { plan_name: "sample" } } });
const FILES = {
  [BOULDER]: BOUND,
  [`${PADS}/sample/learnings.md`]: "\n## 2026-10-02T09:15:00Z\n\nThe ledger rotates at 1,000 entries.\n\n## 2026-10-02T11:00:00Z\n\n- one\n- two\n",
  [`${PADS}/sample/issues.md`]: "\n## 2026-10-02T10:00:00Z\n\nexport `API_TOKEN=abc123def` first\n",
  [`${PADS}/other/learnings.md`]: "\n## 2026-10-01T10:00:00Z\n\nThe other plan's ledger note.\n",
};
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };

const element = (type: string) => (props: Record<string, unknown>, ...children: unknown[]) => {
  const { hover, ...rest } = props;
  return { type, ...(Object.keys(rest).length === 0 ? {} : { props: rest }), ...(hover === undefined ? {} : { hover }), children };
};
const text = element("Text");
const box = element("Box");
const line = (pieces: readonly Piece[]) => text({ wrap: "truncate-end" }, ...pieces.map(({ text: run, ...style }) => text(style, run)));
const button = (key: string, label: string) => ({ type: "Button", props: { key, label, hotkey: key, plain: true }, press: expect.anything() });
const markdown = (key: string, source: string) => ({ type: "Markdown", props: { text: source, key } });
const dated = (width: number, at: number, ascii = false) => line(rule(width, glyphs(ascii), ascii, formatWhen(at)));
const styledCard = (borderStyle: string, key: string, border: string, width: number, title: string, ...children: unknown[]) =>
  box({ key, flexDirection: "column", borderStyle, borderColor: border, paddingX: 1, width }, text({ bold: true, color: "text", wrap: "truncate-end" }, title), ...children);
const card = (key: string, border: string, width: number, title: string, ...children: unknown[]) => styledCard("round", key, border, width, title, ...children);
const quiet = text({ dimColor: true }, "Nothing recorded yet");

// The tab and rule rows the pane draws above a tab's body.
const chrome = (size: Size) => (size.placement === "inline" ? 0 : 1) + (usableColumns(bodyColumns(size)) >= 71 ? 1 : 2);
const bodyOf = (tree: RenderElement, size: Size) => topRows(tree).slice(chrome(size));

async function open($: Engine, size: Size) {
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", size));
  await ui.press({ key: "4" });
  return ui;
}

test("the Notepad tab draws one card per section in its tone, a dated rule above each entry as Markdown, and masks a secret", async ($, on) => {
  world(on, FILES);
  const ui = await open($, DOCK_200);
  const inner = usableColumns(bodyColumns(DOCK_200)) - 4;

  expect(bodyOf(await ui.drawn(), DOCK_200)).toEqual([
    line([
      { text: "sample", color: "planMode", bold: true },
      { text: " " },
      { text: " BOUND ", color: "inverseText", backgroundColor: "planMode", bold: true },
      { text: " · 3 entries", color: "inactive" },
      { text: " · 1 masked", color: "warning" },
    ]),
    box({ key: "notepad-keys", flexDirection: "row", columnGap: 2 }, button("f", "Find"), button("l", "Plans (2)")),
    card(
      "section-learnings",
      "permission",
      inner + 4,
      "Learnings · 2 entries",
      dated(inner, LEARNED_AT),
      markdown("note-learnings-0-0", "The ledger rotates at 1,000 entries."),
      dated(inner, LISTED_AT),
      markdown("note-learnings-1-0", "- one\n- two"),
    ),
    card("section-issues", "warning", inner + 4, "Issues · 1 entry", dated(inner, ISSUE_AT), markdown("note-issues-0-0", "export `API_TOKEN=‹masked›` first")),
    card("section-decisions", "claude", inner + 4, "Decisions · 0 entries", quiet),
    card("section-problems", "error", inner + 4, "Problems · 0 entries", quiet),
  ]);
  await ui.unmount();
});

test("at the split tier the cards sit in two columns, and at the page tier they stack at the body's width", async ($, on) => {
  world(on, FILES);
  const split: Size = { columns: 200, rows: 50, placement: "inline" };
  const wide = await open($, split);
  const half = Math.floor((usableColumns(bodyColumns(split)) - 1) / 2);
  const [columns] = bodyOf(await wide.drawn(), split).slice(2);
  const cards = (column: unknown) => (column as { children: { props: Record<string, unknown> }[] }).children.map((child) => [child.props["key"], child.props["width"]]);
  expect(columns).toMatchObject({ type: "Box", props: { key: "notepad-columns", flexDirection: "row", columnGap: 1 } });
  const [left, right] = (columns as { children: { props: Record<string, unknown> }[] }).children;
  expect([left?.props, right?.props]).toEqual([
    { key: "notepad-column-0", flexDirection: "column", width: half },
    { key: "notepad-column-1", flexDirection: "column", width: half },
  ]);
  expect([cards(left), cards(right)]).toEqual([
    [["section-learnings", half], ["section-decisions", half]],
    [["section-issues", half], ["section-problems", half]],
  ]);
  await wide.unmount();

  const page: Size = { columns: 120, rows: 40, placement: "dock" };
  const narrow = await $.ui.mount(pane("terminal", page));
  const stacked = bodyOf(await narrow.drawn(), page).slice(2);
  const full = usableColumns(bodyColumns(page));
  expect(stacked.map((child) => (child as { props: Record<string, unknown> }).props["width"])).toEqual([full, full, full, full]);
  await narrow.unmount();
});

test("f opens the Find field and asks for its focus, typing filters the entries and drops sections with no match, w clears", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);
  const header = async () => rows(await ui.drawn())[2];
  const sections = async () => (await ui.findAll({ type: "Box" })).flatMap((found) => (found.key?.startsWith("section-") === true ? [found.key] : []));

  expect(await ui.find({ key: "notepad-find" })).toBeUndefined();
  await ui.press({ key: "f" });
  await w.clock.settle();
  expect((await ui.find({ key: "notepad-find" }))?.props).toEqual({ key: "notepad-find", label: "Find", placeholder: "find in entries", value: "" });
  // The test kit cannot resolve a plugin's own $.ui.focus, so the request shows as its refusal.
  expect(w.logs.at(-1)).toBe("omca notepad could not focus notepad-find: no implementation for ui.focus");

  await ui.input({ key: "notepad-find", text: "LEDGER", kind: "change" });
  expect(await header()).toBe("sample  BOUND  · 1 of 3 entries match · 1 masked");
  expect(await sections()).toEqual(["section-learnings"]);
  expect(await ui.find({ type: "Text", text: "Learnings · 1 of 2" })).toBeDefined();
  expect(await ui.find({ key: "note-learnings-0-0" })).toBeDefined();
  expect(await ui.find({ key: "w" })).toBeDefined();

  await ui.input({ key: "notepad-find", text: "nowhere" });
  expect(rows(await ui.drawn()).at(-1)).toBe('No entry matches "nowhere"');

  await ui.press({ key: "w" });
  expect(await ui.find({ key: "notepad-find" })).toBeUndefined();
  expect(await ui.find({ key: "w" })).toBeUndefined();
  expect(await sections()).toEqual(["section-learnings", "section-issues", "section-decisions", "section-problems"]);
  await ui.unmount();
});

test("l lists the plans with notepads, the bound one first, and picking one shows it until another is picked", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);

  await ui.press({ key: "l" });
  await w.clock.settle();
  expect(bodyOf(await ui.drawn(), DOCK_200)).toEqual([
    text({ dimColor: true }, "Notepads · 2 plans, the bound one first"),
    box(
      { key: "notepad-plan-row-sample", flexDirection: "row" },
      text({ color: "claude" }, "❯ "),
      { type: "Button", props: { key: "notepad-plan-sample", label: "sample", plain: true, autoFocus: true }, press: expect.anything() },
      text({}, " "),
      line([{ text: " BOUND ", color: "inverseText", backgroundColor: "planMode", bold: true }]),
    ),
    box(
      { key: "notepad-plan-row-other", flexDirection: "row" },
      text({ color: "claude" }, "  "),
      { type: "Button", props: { key: "notepad-plan-other", label: "other", plain: true }, press: expect.anything() },
    ),
    button("l", "Back"),
  ]);
  expect(w.logs.at(-1)).toBe("omca notepad could not focus notepad-plan-sample: no implementation for ui.focus");

  await ui.press({ key: "notepad-plan-other" });
  expect(rows(await ui.drawn())[2]).toBe("other not bound · 1 entry");
  write(w, `${PADS}/sample/problems.md`, "\n## 2026-10-02T12:00:00Z\n\nA new problem.\n");
  await w.clock.advance(2000);
  await ui.redraw();
  expect(rows(await ui.drawn())[2]).toBe("other not bound · 1 entry");
  expect(await ui.find({ key: "note-learnings-0-0" })).toBeDefined();
  expect(await ui.find({ type: "Markdown", text: "The other plan's ledger note." })).toBeDefined();

  await ui.press({ key: "l" });
  await ui.press({ key: "notepad-plan-sample" });
  expect(rows(await ui.drawn())[2]).toBe("sample  BOUND  · 4 entries · 1 masked");
  await ui.unmount();
});

test("the empty and error states: no notepad anywhere, an empty bound notepad, an unbound session, and an unreadable registry", async ($, on) => {
  const w = world(on, {});
  const ui = await open($, DOCK_200);
  const body = async () => rows(await ui.drawn()).slice(2);
  expect(await body()).toEqual(["No plan has a notepad yet; a plan's agents add one with notepad_write."]);

  write(w, BOULDER, BOUND);
  await w.clock.advance(2000);
  await ui.redraw();
  expect(await body()).toEqual(["sample  BOUND  · 0 entries", "The notepad for sample is empty."]);

  write(w, BOULDER, JSON.stringify({ plans: {}, bindings: {} }));
  write(w, `${PADS}/other/learnings.md`, "\n## 2026-10-01T10:00:00Z\n\nThe other plan's ledger note.\n");
  await w.clock.advance(2000);
  await ui.redraw();
  expect(bodyOf(await ui.drawn(), DOCK_200)[0]).toEqual(
    line([
      { text: "other", color: "planMode", bold: true },
      { text: " " },
      { text: "not bound", color: "inactive" },
      { text: " · 1 entry", color: "inactive" },
    ]),
  );

  write(w, BOULDER, "{ not json");
  await w.clock.advance(2000);
  await ui.redraw();
  const [error] = await body();
  expect(error).toStartWith("✗ Could not read the notepad: ");
  expect((await ui.find({ type: "Text", text: error ?? "" }))?.props).toEqual({ color: "error" });
  await ui.unmount();
});

test("OMCA_ASCII draws the notepad's card borders, rules, chip, separators and masks from the ASCII set", async ($, on) => {
  world(on, FILES, {}, { OMCA_ASCII: "1" });
  const size: Size = { columns: 80, rows: 40, placement: "inline" };
  const ui = await open($, size);
  const inner = usableColumns(bodyColumns(size)) - 4;
  const drawn = rows(await ui.drawn());

  expect(drawn[chrome(size)]).toBe("sample [BOUND] - 3 entries - 1 masked");
  expect(topRows(await ui.drawn())).toContainEqual(
    styledCard("classic", "section-issues", "warning", inner + 4, "Issues - 1 entry", dated(inner, ISSUE_AT, true), markdown("note-issues-0-0", "export `API_TOKEN=<masked>` first")),
  );
  expect(drawn.filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});

test("every notepad row fits the body less the gutter at each size and surface, listed, searched and picking, with only f, w and l as keys", async ($, on) => {
  const w = world(on, FILES);
  await $.command.run(run(""));

  for (const size of SIZES) {
    for (const surface of ["terminal", "desktop"] as const) {
      const room = usableColumns(bodyColumns(size));
      const ui = await $.ui.mount(pane(surface, size));
      await ui.press({ key: "4" });
      const fits = async (what: string) => {
        for (const child of topRows(await ui.drawn())) expect(cellsAcross(child), `${size.columns} ${size.placement} ${surface} ${what}`).toBeLessThanOrEqual(room);
      };
      const keys = async () =>
        (await ui.findAll({ type: "Button" })).flatMap((found) => (typeof found.props["hotkey"] === "string" && !/^\d$/.test(found.props["hotkey"]) ? [found.props["hotkey"]] : [])).sort();
      await fits("listed");
      expect(await keys()).toEqual(["f", "l"]);
      await ui.press({ key: "f" });
      await ui.input({ key: "notepad-find", text: "ledger" });
      await fits("searched");
      expect(await keys()).toEqual(["f", "l", "w"]);
      await ui.press({ key: "w" });
      await ui.press({ key: "l" });
      await fits("picking");
      await ui.press({ key: "l" });
      await w.clock.settle();
      await ui.unmount();
    }
  }
});

test("a notepad taller than the docked body draws a more-below cue over its last row, and none where it fits", async ($, on) => {
  world(on, FILES);
  const SHORT: Size = { columns: 120, rows: 14, placement: "dock" };
  const lastRow = async (size: Size) => {
    const ui = await open($, size);
    const row = rows(await ui.drawn()).at(-1);
    await ui.unmount();
    return row;
  };
  expect(await lastRow(SHORT)).toBe("  ↓ more · ↑↓ scroll".padEnd(usableColumns(bodyColumns(SHORT))));
  expect(await lastRow(DOCK_200)).toBe("Problems · 0 entriesNothing recorded yet");
});
