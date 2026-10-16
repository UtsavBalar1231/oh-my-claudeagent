import type { RenderElement } from "claude-code";
import { type Engine, expect, type Mounted, test } from "claude-code/testing";
import { formatWhen, glyphs, usableColumns } from "../../src/core/ui-kit.ts";
import { type Piece, rule } from "../../src/core/visual.ts";
import {
  bodyColumns,
  BOULDER,
  cellsAcross,
  focusRequests,
  isAscii,
  pane,
  ROOT,
  rows,
  run,
  SESSION,
  type Size,
  SIZES,
  topRows,
  touchDir,
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
const SCROLL = { component: "Pane", requestId: "omca", offset: 0, origin: { kind: "person" } } as const;
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };
const PAGE_120: Size = { columns: 120, rows: 60, placement: "dock" };

const element = (type: string) => (props: Record<string, unknown>, ...children: unknown[]) => {
  const { hover, ...rest } = props;
  return { type, ...(Object.keys(rest).length === 0 ? {} : { props: rest }), ...(hover === undefined ? {} : { hover }), children };
};
const text = element("Text");
const box = element("Box");
const line = (pieces: readonly Piece[]) =>
  text({ wrap: "truncate-end" }, ...pieces.map(({ text: run, bold, ...style }) => text({ ...style, ...(bold === true ? { weight: "semibold" } : {}) }, run)));
const button = (key: string, label: string) => ({ type: "Button", props: { key, label, hotkey: key, plain: true }, press: expect.anything() });
const dated = (width: number, at: number, ascii = false) => line(rule(width, glyphs(ascii ? "ascii" : "unicode"), ascii, formatWhen(at)));
// A section with entries: its tone on a mark, the Button that opens its page, and its newest entry's date.
const sectionRow = (name: string, tone: string, label: string, at: number, isFirst = false) =>
  box(
    { flexDirection: "row" },
    text({ color: tone }, "● "),
    { type: "Button", props: { key: `notepad-section-${name}`, label, plain: true, ...(isFirst ? { autoFocus: true } : {}) }, press: expect.anything() },
    text({ color: "inactive" }, `  ${formatWhen(at)}`),
  );
// The page's region whose content fits: no cue rows and no height of its own.
const pageRegion = (width: number, ...units: unknown[]) =>
  box(
    { key: "notepad-page", width, flexDirection: "column" },
    box({ width, flexDirection: "column", overflow: "hidden" }, box({ width, flexDirection: "column", flexShrink: 0 }, ...units)),
  );

// The tab row, and the rule under it where the dock has the rows for one.
const chrome = (size: Size) => 1 + (size.placement === "dock" && size.rows - 4 >= 30 ? 1 : 0);
const bodyOf = (tree: RenderElement, size: Size) => topRows(tree).slice(chrome(size));

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] };
const childrenOf = (node: unknown): Node[] => ((node as Node | undefined)?.children ?? []) as Node[];
const cuesOf = (region: Node | undefined): string => JSON.stringify(childrenOf(region).filter((child) => child.type === "Text"));

const entries = (count: number, word: string) =>
  Array.from({ length: count }, (_, index) => `\n## 2026-10-02T09:${String(index).padStart(2, "0")}:00Z\n\n${word} ${index}.\n`).join("");

async function open($: Engine, size: Size) {
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", size));
  await ui.press({ key: "4" });
  return ui;
}

const hotkeys = async (ui: Pick<Mounted<"terminal" | "desktop", "Pane">, "findAll">) =>
  (await ui.findAll({ type: "Button" })).flatMap((found) => (typeof found.props["hotkey"] === "string" && !/^\d$/.test(found.props["hotkey"]) ? [found.props["hotkey"]] : [])).sort();

test("the Notepad tab opens on one row per section: its tone on a mark, a Button with its count, its newest entry's date, and a dim line for a section with no entry", async ($, on) => {
  world(on, FILES);
  const ui = await open($, PAGE_120);

  expect(bodyOf(await ui.drawn(), PAGE_120)).toEqual([
    line([
      { text: "sample", color: "planMode", bold: true },
      { text: " " },
      { text: " BOUND ", color: "inverseText", backgroundColor: "planMode", bold: true },
      { text: " · 3 entries", color: "inactive" },
      { text: " · 1 masked", color: "warning" },
    ]),
    box({ key: "notepad-keys", flexDirection: "row", columnGap: 2 }, button("f", "Find"), button("l", "Plans (2)")),
    sectionRow("learnings", "permission", "Learnings · 2 entries", LISTED_AT, true),
    sectionRow("issues", "warning", "Issues · 1 entry", ISSUE_AT),
    text({ dimColor: true }, "○ Decisions · nothing recorded yet"),
    text({ dimColor: true }, "○ Problems · nothing recorded yet"),
  ]);
  await ui.unmount();
});

test("the index keeps all four rows with no section written, and the first row with entries takes the ring", async ($, on) => {
  world(on, { [BOULDER]: BOUND, [`${PADS}/sample/problems.md`]: "\n## 2026-10-02T12:00:00Z\n\nA problem.\n" });
  const ui = await open($, DOCK_200);
  expect(rows(await ui.drawn()).slice(chrome(DOCK_200) + 2)).toEqual([
    "○ Learnings · nothing recorded yet",
    "○ Issues · nothing recorded yet",
    "○ Decisions · nothing recorded yet",
    `● Problems · 1 entry  ${formatWhen(Date.UTC(2026, 9, 2, 12, 0, 0))}`,
  ]);
  expect((await ui.findAll({ type: "Button" })).filter((found) => found.props["autoFocus"] === true).map((found) => found.key)).toEqual(["notepad-section-problems"]);
  expect(await ui.find({ key: "notepad-section-learnings" })).toBeUndefined();
  await ui.unmount();
});

test("Enter on a row opens its page with every entry under its dated rule, the keys below, and b returns with the ring on that row", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, PAGE_120);
  const width = usableColumns(bodyColumns(PAGE_120));

  await ui.press({ key: "notepad-section-learnings" });
  expect(bodyOf(await ui.drawn(), PAGE_120)).toEqual([
    line([
      { text: "sample", color: "planMode", bold: true },
      { text: " · ", color: "inactive" },
      { text: "Learnings", color: "permission", bold: true },
      { text: " · 2 entries", color: "inactive" },
    ]),
    pageRegion(
      width,
      dated(width, LEARNED_AT),
      line([{ text: "The ledger rotates at 1,000 entries." }]),
      dated(width, LISTED_AT),
      line([{ text: "- " }, { text: "one" }]),
      line([{ text: "- " }, { text: "two" }]),
    ),
    box({ key: "notepad-keys", flexDirection: "row", columnGap: 2 }, button("b", "Back"), button("f", "Find")),
  ]);

  await ui.press({ key: "b" });
  await w.clock.settle();
  expect(focusRequests(w.logs).at(-1)).toBe("notepad-section-learnings");
  expect(await ui.find({ key: "notepad-page" })).toBeUndefined();
  expect((await ui.find({ key: "notepad-section-learnings" }))?.props).toMatchObject({ label: "Learnings · 2 entries" });

  await ui.press({ key: "notepad-section-issues" });
  expect(rows(await ui.drawn())[chrome(PAGE_120)]).toBe("sample · Issues · 1 entry · 1 masked");
  expect(await ui.find({ type: "Text", text: "API_TOKEN=‹masked›" })).toBeDefined();
  await ui.unmount();
});

test("Find filters the index and the page, a page query with no match shows the no-match line, and Clear restores both", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);
  const header = async () => rows(await ui.drawn())[chrome(DOCK_200)];

  await ui.press({ key: "f" });
  await w.clock.settle();
  expect((await ui.find({ key: "notepad-find" }))?.props).toEqual({ key: "notepad-find", label: "Find", placeholder: "find in entries", value: "" });
  await ui.input({ key: "notepad-find", text: "LEDGER", kind: "change" });
  expect(await header()).toBe("sample  BOUND  · 1 of 3 entries match · 1 masked");
  expect(rows(await ui.drawn()).slice(chrome(DOCK_200) + 3)).toEqual([
    `● Learnings · 1 of 2 match  ${formatWhen(LEARNED_AT)}`,
    "○ Issues · no match",
    "○ Decisions · nothing recorded yet",
    "○ Problems · nothing recorded yet",
  ]);
  expect(await ui.find({ key: "notepad-section-issues" })).toBeUndefined();

  await ui.press({ key: "notepad-section-learnings" });
  expect(await header()).toBe("sample · Learnings · 1 of 2 entries match");
  expect(await hotkeys(ui)).toEqual(["b", "f", "w"]);
  expect(await ui.find({ type: "Text", text: "The ledger rotates at 1,000 entries." })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "one" })).toBeUndefined();

  await ui.input({ key: "notepad-find", text: "nowhere", kind: "change" });
  expect(await header()).toBe("sample · Learnings · 0 of 2 entries match");
  expect(await ui.find({ type: "Text", text: 'No entry matches "nowhere"' })).toBeDefined();

  await ui.press({ key: "w" });
  expect(await header()).toBe("sample · Learnings · 2 entries");
  expect(await ui.find({ key: "notepad-find" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "one" })).toBeDefined();
  await ui.press({ key: "b" });
  expect(await header()).toBe("sample  BOUND  · 3 entries · 1 masked");
  expect((await ui.find({ key: "notepad-section-issues" }))?.props).toMatchObject({ label: "Issues · 1 entry" });
  await ui.unmount();
});

test("a refresh that empties the open section returns to the index", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);
  await ui.press({ key: "notepad-section-issues" });
  expect(await ui.find({ key: "notepad-page" })).toBeDefined();

  write(w, `${PADS}/sample/issues.md`, "");
  await w.clock.advance(2000);
  await ui.redraw();
  expect(await ui.find({ key: "notepad-page" })).toBeUndefined();
  expect(rows(await ui.drawn()).slice(chrome(DOCK_200))).toEqual([
    "sample  BOUND  · 2 entries",
    "f: Find  l: Plans (2)",
    `● Learnings · 2 entries  ${formatWhen(LISTED_AT)}`,
    "○ Issues · nothing recorded yet",
    "○ Decisions · nothing recorded yet",
    "○ Problems · nothing recorded yet",
  ]);
  await ui.unmount();
});

test("a wheel tick over the page scrolls it by units, the scroll keys move it, and its last row is reachable", async ($, on) => {
  world(on, { ...FILES, [`${PADS}/sample/learnings.md`]: entries(40, "Ledger") });
  const ui = await open($, PAGE_120);
  await ui.press({ key: "notepad-section-learnings" });
  // The page's first row in the pane's rows: the tab row and the rule, then the header.
  const top = chrome(PAGE_120) + 1;
  const tick = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 56, contentRows: 57, pointer: { column: 2, row: top } });
  const key = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 56, contentRows: 57 });
  const region = async () => (await ui.find({ key: "notepad-page" })) as Node | undefined;
  const moved = async () => Number(/↑ (\d+) more/.exec(cuesOf(await region()))?.[1] ?? 0);

  expect((await region())?.props?.["height"]).toBe(PAGE_120.rows - 4 - chrome(PAGE_120) - 2);
  expect(cuesOf(await region())).toContain("wheel to scroll");
  expect(await moved()).toBe(0);
  await tick(3);
  expect(await moved()).toBe(3);
  await $.ui.focus({ component: "Pane", requestId: "omca", element: "f", origin: { kind: "person" } });
  await key(2);
  expect(await moved()).toBe(5);
  await tick(-5);
  expect(await moved()).toBe(0);

  await tick(1000);
  expect(cuesOf(await region())).not.toContain("wheel to scroll");
  expect(JSON.stringify(childrenOf(await region()).at(-1))).toContain("Ledger 39.");
  await ui.unmount();
});

test("on Desktop the page holds every entry with no cue and its keys sit under the header, and every wheel tick reaches the engine", async ($, on) => {
  const w = world(on, { ...FILES, [`${PADS}/sample/learnings.md`]: entries(40, "Ledger") });
  let reached = 0;
  on("ui.scroll", () => {
    reached += 1;
    return {};
  });
  await $.command.run(run(""));

  w.surfaces = ["desktop"];
  const desktop = await $.ui.mount(pane("desktop", PAGE_120));
  await desktop.press({ key: "4" });
  expect((await desktop.find({ key: "notepad-section-learnings" }))?.props).toMatchObject({ label: `Learnings · 40 entries · ${formatWhen(Date.UTC(2026, 9, 2, 9, 39, 0))}` });
  await desktop.press({ key: "notepad-section-learnings" });
  const body = bodyOf(await desktop.drawn(), PAGE_120) as Node[];
  expect(body.map((child) => child.props?.["key"])).toEqual([undefined, "notepad-keys", "notepad-page"]);
  const tree = JSON.stringify(await desktop.drawn());
  expect(Array.from({ length: 40 }, (_, n) => tree.includes(`"Ledger ${n}."`))).toEqual(Array(40).fill(true));
  expect(rows(await desktop.drawn()).filter((row) => row.includes("more"))).toEqual([]);
  await $.ui.scroll({ ...SCROLL, by: 3, bodyRows: 12, contentRows: 120 });
  expect(reached).toBe(1);
  await desktop.unmount();
});

test("OMCA_GLYPHS=ascii draws the notepad's rows, rules, marks, chip, separators and masks from the ASCII set", async ($, on) => {
  world(on, FILES, {}, { OMCA_GLYPHS: "ascii" });
  const size: Size = { columns: 80, rows: 40, placement: "inline" };
  const ui = await open($, size);
  const drawn = rows(await ui.drawn());

  expect(drawn[chrome(size)]).toBe("sample [BOUND] - 3 entries - 1 masked");
  expect(drawn.slice(chrome(size) + 2, chrome(size) + 6)).toEqual([
    `* Learnings - 2 entries  ${formatWhen(LISTED_AT)}`,
    `* Issues - 1 entry  ${formatWhen(ISSUE_AT)}`,
    "o Decisions - nothing recorded yet",
    "o Problems - nothing recorded yet",
  ]);
  expect(drawn.filter((row) => !isAscii(row))).toEqual([]);

  await ui.press({ key: "notepad-section-issues" });
  const page = rows(await ui.drawn());
  expect(page[chrome(size)]).toBe("sample - Issues - 1 entry - 1 masked");
  expect(await ui.find({ type: "Text", text: "API_TOKEN=" })).toBeDefined();
  expect(page.filter((row) => !isAscii(row))).toEqual([]);
  await ui.unmount();
});

test("every notepad row fits the body less the gutter at each size and surface on the index, the page, finding and picking, with only b, f, w and l as keys", async ($, on) => {
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
      await fits("index");
      expect(await hotkeys(ui)).toEqual(["f", "l"]);
      await ui.press({ key: "f" });
      await ui.input({ key: "notepad-find", text: "ledger" });
      await fits("index finding");
      expect(await hotkeys(ui)).toEqual(["f", "l", "w"]);
      await ui.press({ key: "notepad-section-learnings" });
      await fits("page finding");
      expect(await hotkeys(ui)).toEqual(["b", "f", "w"]);
      await ui.press({ key: "w" });
      await fits("page");
      expect(await hotkeys(ui)).toEqual(["b", "f"]);
      await ui.press({ key: "b" });
      await ui.press({ key: "l" });
      await fits("picking");
      await ui.press({ key: "l" });
      await w.clock.settle();
      await ui.unmount();
    }
  }
});

test("with Find open the header drops its masked count, then shortens to match, instead of ending in a cut", async ($, on) => {
  const w = world(on, FILES);
  const header = async (size: Size) => {
    const ui = await open($, size);
    await ui.press({ key: "f" });
    await w.clock.settle();
    await ui.input({ key: "notepad-find", text: "ledger", kind: "change" });
    const row = rows(await ui.drawn())[chrome(size)];
    await ui.unmount();
    return row?.trimEnd();
  };
  expect(await header({ columns: 120, rows: 40, placement: "inline" })).toBe("sample  BOUND  · 1 of 3 entries match · 1 masked");
  expect(await header({ columns: 48, rows: 40, placement: "inline" })).toBe("sample  BOUND  · 1 of 3 entries match");
  expect(await header({ columns: 40, rows: 40, placement: "inline" })).toBe("sample  BOUND  · 1 of 3 match");
});

test("submitting the Find field only submits: the query and the filtered view stay, and the Clear key was there while typing", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);
  const keys = () => hotkeys(ui);
  await ui.press({ key: "f" });
  await w.clock.settle();
  expect(await keys()).toEqual(["f", "l", "w"]);
  await ui.input({ key: "notepad-find", text: "ledger", kind: "change" });
  expect(await keys()).toEqual(["f", "l", "w"]);

  await ui.input({ key: "notepad-find", text: "ledger", kind: "submit" });
  expect(await ui.find({ key: "notepad-find" })).toBeUndefined();
  expect(await ui.find({ key: "notepad-plan-row-sample" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "Find: ledger" })).toBeDefined();
  expect(rows(await ui.drawn())[chrome(DOCK_200)]).toBe("sample  BOUND  · 1 of 3 entries match · 1 masked");
  expect(await keys()).toEqual(["f", "l", "w"]);

  await ui.press({ key: "f" });
  await w.clock.settle();
  expect((await ui.find({ key: "notepad-find" }))?.props).toMatchObject({ value: "ledger" });
  await ui.unmount();
});

test("l lists the plans with notepads, the bound one first, and picking one shows its index until another is picked", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);

  await ui.press({ key: "notepad-section-learnings" });
  await ui.press({ key: "b" });
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
  expect(rows(await ui.drawn())[chrome(DOCK_200)]).toBe("other not bound · 1 entry");
  write(w, `${PADS}/sample/problems.md`, "\n## 2026-10-02T12:00:00Z\n\nA new problem.\n");
  await w.clock.advance(2000);
  await ui.redraw();
  expect(rows(await ui.drawn())[chrome(DOCK_200)]).toBe("other not bound · 1 entry");
  expect(rows(await ui.drawn()).slice(chrome(DOCK_200) + 2)).toEqual([
    `● Learnings · 1 entry  ${formatWhen(Date.UTC(2026, 9, 1, 10, 0, 0))}`,
    "○ Issues · nothing recorded yet",
    "○ Decisions · nothing recorded yet",
    "○ Problems · nothing recorded yet",
  ]);
  await ui.press({ key: "notepad-section-learnings" });
  expect(await ui.find({ type: "Text", text: "The other plan's ledger note." })).toBeDefined();
  await ui.press({ key: "b" });

  await ui.press({ key: "l" });
  await ui.press({ key: "notepad-plan-sample" });
  expect(rows(await ui.drawn())[chrome(DOCK_200)]).toBe("sample  BOUND  · 4 entries · 1 masked");
  await ui.unmount();
});

test("the empty and error states: no notepad anywhere, an empty bound notepad, an unbound session, and an unreadable registry", async ($, on) => {
  const w = world(on, {});
  const ui = await open($, DOCK_200);
  const body = async () => rows(await ui.drawn()).slice(chrome(DOCK_200));
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

test("an unbound session opens the most recently written notepad, not the first name", async ($, on) => {
  world(on, {
    [`${PADS}/alpha/learnings.md`]: "\n## 2026-10-01T10:00:00Z\n\nThe older note.\n",
    [`${PADS}/zeta/learnings.md`]: "\n## 2026-10-02T10:00:00Z\n\nThe newer note.\n",
  });
  const ui = await open($, DOCK_200);
  expect(rows(await ui.drawn())[chrome(DOCK_200)]).toBe("zeta not bound · 1 entry");
  await ui.unmount();
});

test("idle ticks list no notepad directory but the shown one, and the ranking is listed again only when .omca/notepads moves", async ($, on) => {
  const w = world(on, { ...FILES, [`${PADS}/alpha/learnings.md`]: "\n## 2026-10-01T10:00:00Z\n\nThe older note.\n" });
  const ui = await open($, DOCK_200);
  const listed = () => w.lists.splice(0);
  expect(listed()).toContain(`${PADS}/alpha`);

  await w.clock.advance(6000);
  expect(listed().filter((path) => path !== `${PADS}/sample`)).toEqual([]);

  touchDir(w, PADS, 5_000);
  await w.clock.advance(2000);
  expect(listed()).toContain(`${PADS}/alpha`);
  await ui.unmount();
});

test("an unbound session ranks a notepad written since .omca/notepads moved, and a write that left the directory alone waits for it", async ($, on) => {
  const w = world(on, {
    [`${PADS}/alpha/learnings.md`]: "\n## 2026-10-01T10:00:00Z\n\nThe older note.\n",
    [`${PADS}/zeta/learnings.md`]: "\n## 2026-10-02T10:00:00Z\n\nThe newer note.\n",
  });
  const ui = await open($, DOCK_200);
  const header = async () => {
    await w.clock.advance(2000);
    await ui.redraw();
    return rows(await ui.drawn())[chrome(DOCK_200)];
  };
  expect(await header()).toBe("zeta not bound · 1 entry");

  for (let count = 0; count < 3; count++) write(w, `${PADS}/fresh/learnings.md`, "\n## 2026-10-02T12:00:00Z\n\nJust written.\n");
  expect(await header()).toBe("zeta not bound · 1 entry");

  touchDir(w, PADS, 5_000);
  expect(await header()).toBe("fresh not bound · 1 entry");
  await ui.unmount();
});

test("the bound notepad shows a new entry while .omca/notepads does not move", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);
  const header = async () => {
    await w.clock.advance(2000);
    await ui.redraw();
    return rows(await ui.drawn())[chrome(DOCK_200)];
  };
  expect(await header()).toBe("sample  BOUND  · 3 entries · 1 masked");

  write(w, `${PADS}/sample/problems.md`, "\n## 2026-10-02T12:00:00Z\n\nA new problem.\n");
  expect(await header()).toBe("sample  BOUND  · 4 entries · 1 masked");
  await ui.unmount();
});
