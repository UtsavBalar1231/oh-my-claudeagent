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
const SCROLL = { component: "Pane", requestId: "omca", offset: 0, origin: { kind: "person" } } as const;
const SPLIT_240: Size = { columns: 240, rows: 60, placement: "dock" };
const DOCK_200: Size = { columns: 200, rows: 50, placement: "dock" };
const PAGE_120: Size = { columns: 120, rows: 60, placement: "dock" };

const element = (type: string) => (props: Record<string, unknown>, ...children: unknown[]) => {
  const { hover, ...rest } = props;
  return { type, ...(Object.keys(rest).length === 0 ? {} : { props: rest }), ...(hover === undefined ? {} : { hover }), children };
};
const text = element("Text");
const box = element("Box");
const line = (pieces: readonly Piece[]) => text({ wrap: "truncate-end" }, ...pieces.map(({ text: run, ...style }) => text(style, run)));
const button = (key: string, label: string) => ({ type: "Button", props: { key, label, hotkey: key, plain: true }, press: expect.anything() });
const title = (name: string, label: string, isDim = false) => ({
  type: "Button",
  props: { key: `notepad-title-${name}`, label, plain: true, ...(isDim ? { dimColor: true } : {}) },
  press: expect.anything(),
});
const dated = (width: number, at: number, ascii = false) => line(rule(width, glyphs(ascii ? "ascii" : "unicode"), ascii, formatWhen(at)));
// A region whose content fits: no cue rows and no height of its own.
const region = (name: string, width: number, ...units: unknown[]) =>
  box(
    { key: `notepad-card-${name}`, width, flexDirection: "column" },
    box({ width, flexDirection: "column", overflow: "hidden" }, box({ width, flexDirection: "column", flexShrink: 0 }, ...units)),
  );
const styledCard = (borderStyle: string, key: string, border: string, width: number, heading: unknown, ...children: unknown[]) =>
  box({ key, flexDirection: "column", borderStyle, borderColor: border, paddingX: 1, width }, heading, ...children);
const card = (key: string, border: string, width: number, heading: unknown, ...children: unknown[]) =>
  styledCard("round", key, border, width, heading, ...children);
const quiet = text({ dimColor: true }, "Nothing recorded yet");

// The tab row, and the rule under it where the dock has the rows for one.
const chrome = (size: Size) => 1 + (size.placement === "dock" && size.rows - 4 >= 30 ? 1 : 0);
const bodyOf = (tree: RenderElement, size: Size) => topRows(tree).slice(chrome(size));

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] };
const childrenOf = (node: unknown): Node[] => ((node as Node | undefined)?.children ?? []) as Node[];
const cuesOf = (region: Node | undefined): string => JSON.stringify(childrenOf(region).filter((child) => child.type === "Text"));
const regionOf = (card: Node | undefined) => childrenOf(card).at(-1);
const keysOf = (nodes: readonly Node[]) => nodes.map((node) => node.props?.["key"]);

const entries = (count: number, word: string) =>
  Array.from({ length: count }, (_, index) => `\n## 2026-10-02T09:${String(index).padStart(2, "0")}:00Z\n\n${word} ${index}.\n`).join("");

async function open($: Engine, size: Size) {
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", size));
  await ui.press({ key: "4" });
  return ui;
}

// Each card as [card key, width, region key, region height]; the height is absent where the content fits.
// The blank rows a pane adds past its body, so the wheel still reaches a card, are not cards.
const cardsIn = (nodes: readonly Node[]) =>
  nodes
    .filter((node) => node.type === "Box" && node.props?.["key"] !== "more-cue")
    .map((node) => [node.props?.["key"], node.props?.["width"], regionOf(node)?.props?.["key"], regionOf(node)?.props?.["height"]]);

test("the Notepad tab draws one card per section in its tone, a title button, a dated rule above each entry, its markdown a row at a time, and masks a secret", async ($, on) => {
  world(on, FILES);
  const ui = await open($, PAGE_120);
  const inner = usableColumns(bodyColumns(PAGE_120)) - 4;

  expect(bodyOf(await ui.drawn(), PAGE_120)).toEqual([
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
      title("learnings", "Learnings · 2 entries"),
      region(
        "learnings",
        inner,
        dated(inner, LEARNED_AT),
        line([{ text: "The ledger rotates at 1,000 entries." }]),
        dated(inner, LISTED_AT),
        line([{ text: "- " }, { text: "one" }]),
        line([{ text: "- " }, { text: "two" }]),
      ),
    ),
    card(
      "section-issues",
      "warning",
      inner + 4,
      title("issues", "Issues · 1 entry"),
      region("issues", inner, dated(inner, ISSUE_AT), line([{ text: "export " }, { text: "API_TOKEN=‹masked›", color: "permission" }, { text: " first" }])),
    ),
    card("section-decisions", "claude", inner + 4, title("decisions", "Decisions · 0 entries"), region("decisions", inner, quiet)),
    card("section-problems", "error", inner + 4, title("problems", "Problems · 0 entries"), region("problems", inner, quiet)),
  ]);
  await ui.unmount();
});

test("two columns hold the cards by height only where each column gives every card three rows, else the cards stack", async ($, on) => {
  world(on, FILES);
  const wide = await open($, SPLIT_240);
  const half = Math.floor((usableColumns(bodyColumns(SPLIT_240)) - 1) / 2);
  const [columns] = bodyOf(await wide.drawn(), SPLIT_240).slice(2);
  expect(columns).toMatchObject({ type: "Box", props: { key: "notepad-columns", flexDirection: "row", columnGap: 1 } });
  const [left, right] = childrenOf(columns);
  expect(keysOf([left, right].filter((column): column is Node => column !== undefined))).toEqual(["notepad-column-0", "notepad-column-1"]);
  expect([left, right].map((column) => cardsIn(childrenOf(column)))).toEqual([
    [["section-learnings", half, "notepad-card-learnings", undefined], ["section-problems", half, "notepad-card-problems", undefined]],
    [["section-issues", half, "notepad-card-issues", undefined], ["section-decisions", half, "notepad-card-decisions", undefined]],
  ]);
  await wide.unmount();
});

test("cards stack when a column could not give each of its cards three rows", async ($, on) => {
  const FULL: Record<string, string> = { ...FILES };
  for (const name of ["learnings", "issues", "decisions", "problems"]) FULL[`${PADS}/sample/${name}.md`] = entries(40, name);
  world(on, FULL);
  const short: Size = { columns: 240, rows: 14, placement: "dock" };
  const crowded = await open($, short);
  const full = usableColumns(bodyColumns(short));
  const stacked = bodyOf(await crowded.drawn(), short).slice(2) as Node[];
  expect(cardsIn(stacked)).toEqual([
    ["section-learnings", full, "notepad-card-learnings", 3],
    ["section-issues", full, "notepad-card-issues", 3],
    ["section-decisions", full, "notepad-card-decisions", 3],
    ["section-problems", full, "notepad-card-problems", 3],
  ]);
  await crowded.unmount();
});

test("stacked cards each scroll in a share of the body, and a card that fits keeps its own height", async ($, on) => {
  world(on, { ...FILES, [`${PADS}/sample/learnings.md`]: entries(40, "Ledger"), [`${PADS}/sample/decisions.md`]: entries(40, "Choice"), [`${PADS}/sample/problems.md`]: entries(40, "Trouble") });
  const ui = await open($, PAGE_120);
  const full = usableColumns(bodyColumns(PAGE_120));
  expect(cardsIn(bodyOf(await ui.drawn(), PAGE_120).slice(2) as Node[])).toEqual([
    ["section-learnings", full, "notepad-card-learnings", 13],
    ["section-issues", full, "notepad-card-issues", undefined],
    ["section-decisions", full, "notepad-card-decisions", 13],
    ["section-problems", full, "notepad-card-problems", 12],
  ]);
  await ui.unmount();
});

test("one section shown takes the full width", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, SPLIT_240);
  await ui.press({ key: "f" });
  await w.clock.settle();
  await ui.input({ key: "notepad-find", text: "ledger", kind: "change" });
  const [only, ...after] = bodyOf(await ui.drawn(), SPLIT_240).slice(3) as Node[];
  expect([only?.props?.["key"], only?.props?.["width"], after]).toEqual(["section-learnings", usableColumns(bodyColumns(SPLIT_240)), []]);
  await ui.unmount();
});

test("the tallest card sits alone in its column while the rest balance, and empty sections fold under them", async ($, on) => {
  world(on, { [BOULDER]: BOUND, [`${PADS}/sample/learnings.md`]: entries(40, "Ledger"), [`${PADS}/sample/problems.md`]: entries(1, "Trouble") });
  const lopsided = await open($, SPLIT_240);
  const half = Math.floor((usableColumns(bodyColumns(SPLIT_240)) - 1) / 2);
  const [columns, fold] = bodyOf(await lopsided.drawn(), SPLIT_240).slice(2);
  expect(childrenOf(columns).map((column) => cardsIn(childrenOf(column)))).toEqual([
    [["section-learnings", half, "notepad-card-learnings", expect.any(Number)]],
    [["section-problems", half, "notepad-card-problems", undefined]],
  ]);
  expect(fold).toEqual(text({ dimColor: true }, "Nothing yet in Issues, Decisions"));
  await lopsided.unmount();
});

test("sections with no entry fold into one line unless every card fits", async ($, on) => {
  world(on, FILES);
  const tight: Size = { columns: 200, rows: 16, placement: "dock" };
  const ui = await open($, tight);
  const [columns, fold, ...rest] = bodyOf(await ui.drawn(), tight).slice(2) as Node[];
  expect([columns?.props?.["key"], fold, rest]).toEqual(["notepad-columns", text({ dimColor: true }, "Nothing yet in Decisions, Problems"), []]);
  expect(childrenOf(columns).map((column) => keysOf(childrenOf(column)))).toEqual([["section-learnings"], ["section-issues"]]);
  await ui.unmount();
});

test("under eight body rows the cards lose their frames, and the keys join the header row where they fit", async ($, on) => {
  world(on, FILES);
  const wide: Size = { columns: 160, rows: 12, placement: "dock" };
  const ui = await open($, wide);
  const [head, ...cards] = bodyOf(await ui.drawn(), wide) as Node[];
  expect(head).toMatchObject({ type: "Box", props: { key: "notepad-head", flexDirection: "row", columnGap: 2 } });
  expect(childrenOf(head).map((child) => child.type)).toEqual(["Text", "Box"]);
  const [learnings] = cards;
  expect(learnings?.props).toEqual({ key: "section-learnings", flexDirection: "column", width: usableColumns(bodyColumns(wide)) });
  expect(childrenOf(learnings)[0]).toEqual(title("learnings", "Learnings · 2 entries", true));
  expect(regionOf(learnings)?.props?.["key"]).toBe("notepad-card-learnings");
  await ui.unmount();

  const narrow: Size = { columns: 120, rows: 12, placement: "dock" };
  const apart = await open($, narrow);
  expect(bodyOf(await apart.drawn(), narrow).slice(0, 2).map((child) => (child as Node).type)).toEqual(["Text", "Box"]);
  expect(keysOf(bodyOf(await apart.drawn(), narrow).slice(1) as Node[])[0]).toBe("notepad-keys");
  await apart.unmount();
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
  const keys = async () =>
    (await ui.findAll({ type: "Button" })).flatMap((found) => (typeof found.props["hotkey"] === "string" && !/^\d$/.test(found.props["hotkey"]) ? [found.props["hotkey"]] : [])).sort();
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

test("each card's title is a button that does nothing, and the ring on it aims the scroll keys at that card", async ($, on) => {
  world(on, { ...FILES, [`${PADS}/sample/learnings.md`]: entries(40, "Ledger"), [`${PADS}/sample/decisions.md`]: entries(40, "Choice") });
  const ui = await open($, DOCK_200);
  const offsets = async () =>
    (await Promise.all(["learnings", "decisions"].map(async (name) => cuesOf((await ui.find({ key: `notepad-card-${name}` })) as Node | undefined))))
      .map((cues) => Number(/↑ (\d+) more/.exec(cues)?.[1] ?? 0));
  const key = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 44, contentRows: 46 });
  const focus = (element: string) => $.ui.focus({ component: "Pane", requestId: "omca", element, origin: { kind: "person" } });

  await ui.press({ key: "notepad-title-learnings" });
  expect(await offsets()).toEqual([0, 0]);
  await key(1);
  expect(await offsets()).toEqual([1, 0]);

  await focus("notepad-title-decisions");
  await key(2);
  expect(await offsets()).toEqual([1, 2]);

  await focus("f");
  await key(1);
  expect(await offsets()).toEqual([2, 2]);
  await ui.unmount();
});

test("f opens the Find field and asks for its focus, typing filters the entries and drops sections with no match, w clears", async ($, on) => {
  const w = world(on, FILES);
  const ui = await open($, DOCK_200);
  const header = async () => rows(await ui.drawn())[chrome(DOCK_200)];
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
  expect((await ui.find({ key: "notepad-title-learnings" }))?.props).toMatchObject({ label: "Learnings · 1 of 2" });
  expect(await ui.find({ type: "Text", text: "The ledger rotates at 1,000 entries." })).toBeDefined();
  expect(await ui.find({ key: "w" })).toBeDefined();

  await ui.input({ key: "notepad-find", text: "nowhere" });
  expect(rows(await ui.drawn()).at(-1)).toBe('No entry matches "nowhere"');

  await ui.press({ key: "w" });
  expect(await ui.find({ key: "notepad-find" })).toBeUndefined();
  expect(await ui.find({ key: "w" })).toBeUndefined();
  expect(await sections()).toEqual(["section-learnings", "section-problems", "section-issues", "section-decisions"]);
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
  expect(rows(await ui.drawn())[chrome(DOCK_200)]).toBe("other not bound · 1 entry");
  write(w, `${PADS}/sample/problems.md`, "\n## 2026-10-02T12:00:00Z\n\nA new problem.\n");
  await w.clock.advance(2000);
  await ui.redraw();
  expect(rows(await ui.drawn())[chrome(DOCK_200)]).toBe("other not bound · 1 entry");
  expect(await ui.find({ type: "Text", text: "The other plan's ledger note." })).toBeDefined();

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

test("OMCA_GLYPHS=ascii draws the notepad's card borders, rules, chip, separators and masks from the ASCII set", async ($, on) => {
  world(on, FILES, {}, { OMCA_GLYPHS: "ascii" });
  const size: Size = { columns: 80, rows: 40, placement: "inline" };
  const ui = await open($, size);
  const drawn = rows(await ui.drawn());

  expect(drawn[chrome(size)]).toBe("sample [BOUND] - 3 entries - 1 masked");
  expect((await ui.find({ key: "section-issues" }))?.props).toMatchObject({ borderStyle: "classic", borderColor: "warning" });
  expect((await ui.find({ key: "notepad-title-issues" }))?.props).toMatchObject({ label: "Issues - 1 entry" });
  expect(await ui.find({ type: "Text", text: "API_TOKEN=" })).toBeDefined();
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

// The first card row in the pane's coordinates: the tab rows and the rule, then the header and the keys.
const COLUMNS_ROW = chrome(SPLIT_240) + 2;
// A card's border and title rows above its region.
const CARD_TOP = 2;
const CARD_CHROME = 3;

async function splitCards(ui: Awaited<ReturnType<typeof open>>) {
  const [columns] = bodyOf(await ui.drawn(), SPLIT_240).slice(2);
  const [left, right] = childrenOf(columns).map(childrenOf);
  return { learnings: left?.[0], decisions: left?.[1], issues: right?.[0], problems: right?.[1] };
}

test("at the split tier a wheel tick over a card scrolls that card's region by units and leaves the other cards", async ($, on) => {
  world(on, {
    ...FILES,
    [`${PADS}/sample/learnings.md`]: entries(40, "Ledger"),
    [`${PADS}/sample/decisions.md`]: entries(40, "Choice"),
    [`${PADS}/sample/issues.md`]: entries(40, "Issue"),
  });
  const ui = await open($, SPLIT_240);
  const half = Math.floor((usableColumns(bodyColumns(SPLIT_240)) - 1) / 2);
  const tick = (column: number, row: number, by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 12, contentRows: 13, pointer: { column, row } });
  const moved = async () => {
    const cards = await splitCards(ui);
    return [cards.learnings, cards.decisions, cards.issues, cards.problems].map((card) => Number(/↑ (\d+) more/.exec(cuesOf(regionOf(card)))?.[1] ?? 0));
  };

  let cards = await splitCards(ui);
  const learningsHeight = Number(regionOf(cards.learnings)?.props?.["height"]);
  const decisionsHeight = Number(regionOf(cards.decisions)?.props?.["height"]);
  expect(learningsHeight - decisionsHeight).toBeLessThanOrEqual(1);
  expect(learningsHeight - decisionsHeight).toBeGreaterThanOrEqual(0);
  expect(await moved()).toEqual([0, 0, 0, 0]);
  expect(cuesOf(regionOf(cards.learnings))).toContain("wheel to scroll");
  expect(cuesOf(regionOf(cards.decisions))).toContain("wheel to scroll");
  expect(cuesOf(regionOf(cards.issues))).toContain("wheel to scroll");
  expect(cuesOf(regionOf(cards.problems))).toBe("[]");

  const learningsTop = COLUMNS_ROW + CARD_TOP;
  const decisionsTop = learningsTop + learningsHeight + CARD_CHROME;
  await tick(2, learningsTop, 3);
  expect(await moved()).toEqual([3, 0, 0, 0]);

  await tick(half + 3, learningsTop, 2);
  expect(await moved()).toEqual([3, 0, 2, 0]);

  await tick(2, decisionsTop, 4);
  expect(await moved()).toEqual([3, 4, 2, 0]);

  await tick(2, learningsTop, -3);
  expect(await moved()).toEqual([0, 4, 2, 0]);
  await ui.unmount();
});

const textOf = (node: unknown): string => (typeof node === "string" ? node : childrenOf(node).map(textOf).join(""));
// The rows a card's region shows in its window, cue rows left out.
const shownRows = (card: Node | undefined): string[] => {
  const window = childrenOf(regionOf(card)).find((child) => child.props?.["overflow"] === "hidden");
  return childrenOf(childrenOf(window)[0]).map(textOf);
};

test("a paragraph taller than its card scrolls a row a wheel tick, and its last row comes into view", async ($, on) => {
  const words = Array.from({ length: 1200 }, (_, index) => `word${index}`);
  world(on, { ...FILES, [`${PADS}/sample/learnings.md`]: `\n## 2026-10-02T09:15:00Z\n\n${words.join(" ")}\n` });
  const ui = await open($, SPLIT_240);
  const tick = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 12, contentRows: 13, pointer: { column: 2, row: COLUMNS_ROW + CARD_TOP } });
  const shown = async () => shownRows((await splitCards(ui)).learnings);

  const first = await shown();
  expect(first[0]).toStartWith("── ");
  expect(first[1]).toStartWith("word0 word1 ");
  await tick(1);
  expect((await shown())[0]).toBe(first[1]);
  await tick(1);
  expect((await shown())[0]).toBe(first[2]);
  await tick(1000);
  expect((await shown()).at(-1)).toEndWith("word1199");
  await ui.unmount();
});

test("a card whose content fits shows no cue and keeps its place under the wheel, and the end of a long card is reachable", async ($, on) => {
  world(on, { ...FILES, [`${PADS}/sample/learnings.md`]: entries(40, "Ledger") });
  const ui = await open($, SPLIT_240);
  const half = Math.floor((usableColumns(bodyColumns(SPLIT_240)) - 1) / 2);
  const tick = (column: number, row: number, by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 12, contentRows: 13, pointer: { column, row } });
  const top = COLUMNS_ROW + CARD_TOP;

  let { learnings, issues, decisions } = await splitCards(ui);
  expect(cuesOf(regionOf(issues))).toBe("[]");
  expect(cuesOf(regionOf(learnings))).toContain("wheel to scroll");
  expect(regionOf(issues)?.props?.["height"]).toBeUndefined();

  await tick(half + 3, top, 5);
  ({ learnings, issues, decisions } = await splitCards(ui));
  expect(cuesOf(regionOf(issues))).toBe("[]");
  expect(cuesOf(regionOf(learnings))).not.toContain("↑");

  await tick(2, top, 1000);
  ({ learnings, issues, decisions } = await splitCards(ui));
  const region = regionOf(learnings);
  expect(cuesOf(region)).not.toContain("wheel to scroll");
  expect(cuesOf(region)).toMatch(/↑ \d+ more/);
  expect(childrenOf(region).map((child) => [child.type, child.props?.["overflow"]])).toEqual([["Text", undefined], ["Box", "hidden"]]);
  expect(JSON.stringify(childrenOf(region).at(-1))).toContain("Ledger 39.");
  expect(cuesOf(regionOf(issues))).toBe("[]");
  expect(cuesOf(regionOf(decisions))).toBe("[]");
  await ui.unmount();
});
