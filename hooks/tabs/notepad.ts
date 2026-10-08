import type { RenderElement } from "claude-code";
import { isPlanName, matches, NOTEPAD_SECTIONS, type NotepadSection, parseEntries } from "../../src/core/notepad.ts";
import { BOULDER } from "../../src/core/omca-paths.ts";
import { clean } from "../../src/core/checkboxes.ts";
import { displayWidth, fitEnd, formatWhen } from "../../src/core/ui-kit.ts";
import { chip, fitPieces, type Piece, piecesWidth, redact, type Tone, TONE_KEYS } from "../../src/core/visual.ts";
import type { Input } from "../dispatch.ts";
import { boundPlanOf, type Host, reason, type State } from "../host.ts";
import { keyButton, noticeRow, patchPane, refocus, type TabView, type View } from "../pane.ts";
import { aimKeys, markdownUnits, resetOffset, ScrollRegion, type Unit } from "../regions.ts";
import { Card, Field, Line, Rule } from "../ui.ts";

type Notepad = NonNullable<State["pane"]["notepad"]>;

const NOTEPADS = ".omca/notepads";
const FIND = "notepad-find";
const PICK = "notepad-plan-";
const KEY_GAP = 2;
const COLUMN_GAP = 1;
// A card's round border and its one-cell padding on each side.
const CARD_FRAME = 4;
// A card's two border rows and its title row.
const CARD_ROWS = 3;
// Border plus padding across, border plus title down: where a card's content starts.
const CARD_INSET = 2;
// A frameless card keeps its title as a heading line above its content.
const HEADING_ROWS = 1;
// Under this many body rows the cards lose their frames.
const FRAMED_FROM = 8;
// The rows of content a card needs before it draws scroll cues.
const MIN_CONTENT = 3;
const cardKey = (name: NotepadSection) => `notepad-card-${name}`;
const titleKey = (name: NotepadSection) => `notepad-title-${name}`;
const TONES: Readonly<Record<NotepadSection, Tone>> = { learnings: "info", issues: "warn", decisions: "active", problems: "fail" };

let signature: string | undefined;
let chosen: string | undefined;
let query = "";
let isSearching = false;
let isPicking = false;

const resetCards = (): void => {
  for (const name of NOTEPAD_SECTIONS) resetOffset(cardKey(name));
};

export const reset = (): void => {
  resetCards();
  signature = undefined;
  chosen = undefined;
  query = "";
  isSearching = false;
  isPicking = false;
};

async function boundPlan(host: Host, root: string): Promise<{ name: string | undefined; seen: string }> {
  const path = `${root}/${BOULDER}`;
  if (!(await host.fs.exists(path))) return { name: undefined, seen: "" };
  const { mtimeMs } = await host.fs.stat(path);
  return { name: (await boundPlanOf(host))?.name, seen: `${mtimeMs}` };
}

// The bound plan first, then the most recently written.
async function notepadPlans(host: Host, root: string, bound: string | undefined): Promise<{ name: string; seen: string }[]> {
  const dir = `${root}/${NOTEPADS}`;
  const found = (await host.fs.exists(dir)) ? (await host.fs.list(dir)).filter((entry) => entry.kind === "dir" && isPlanName(entry.name)) : [];
  const rest = found
    .filter((entry) => entry.name !== bound)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    .map((entry) => ({ name: entry.name, seen: `${entry.mtimeMs}` }));
  return bound === undefined ? rest : [{ name: bound, seen: "" }, ...rest];
}

// Unchanged files answer undefined, so a refresh writes, and redraws, nothing.
export async function read(
  host: Host,
  root: string,
): Promise<{ notepad: Notepad | null; error: string | null } | undefined> {
  try {
    const bound = await boundPlan(host, root);
    const plans = await notepadPlans(host, root, bound.name);
    const shown = plans.find((plan) => plan.name === chosen) ?? plans[0];
    if (shown === undefined) {
      if (signature === "none") return undefined;
      signature = "none";
      return { notepad: null, error: null };
    }
    const dir = `${root}/${NOTEPADS}/${shown.name}`;
    const files = (await host.fs.exists(dir)) ? await host.fs.list(dir) : [];
    const present = NOTEPAD_SECTIONS.flatMap((name) => {
      const file = files.find((entry) => entry.kind === "file" && entry.name === `${name}.md`);
      return file === undefined ? [] : [{ name, path: `${dir}/${file.name}`, seen: `${file.mtimeMs}:${file.size}` }];
    });
    const seen = [
      bound.name ?? "",
      bound.seen,
      shown.name,
      ...plans.map((plan) => `${plan.name}:${plan.seen}`),
      ...present.map((section) => `${section.name}:${section.seen}`),
    ].join("|");
    if (seen === signature) return undefined;
    const sections = await Promise.all(
      present.map(async (section) => ({ name: section.name, text: clean(await host.fs.read(section.path)).trim() })),
    );
    signature = seen;
    return {
      notepad: {
        planName: shown.name,
        bound: bound.name ?? null,
        plans: plans.map((plan) => plan.name),
        sections: sections.filter((section) => section.text !== ""),
      },
      error: null,
    };
  } catch (error) {
    const failure = `Could not read the notepad: ${reason(error)}`;
    if (signature === failure) return undefined;
    signature = failure;
    return { notepad: null, error: failure };
  }
}

async function choose(host: Host, name: string): Promise<void> {
  chosen = name;
  resetCards();
  isPicking = false;
  signature = undefined;
  const pad = await read(host, await host.session.root());
  if (pad !== undefined) {
    await patchPane(host, (pane) => ({ ...pane, notepad: pad.notepad, errors: { ...pane.errors, notepad: pad.error } }));
  }
  host.ui.invalidate();
}

const heading = (name: NotepadSection) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

type Shown = { name: NotepadSection; total: number; entries: { at: number | null; text: string }[] };

function shownSections(notepad: Notepad, view: View): { sections: Shown[]; masked: number } {
  let masked = 0;
  const sections = NOTEPAD_SECTIONS.map((name) => {
    const entries = parseEntries(notepad.sections.find((section) => section.name === name)?.text ?? "").map((entry) => {
      const cleaned = redact(entry.text, view.home, view.g.mask);
      masked += cleaned.masked;
      return { at: entry.at, text: cleaned.text };
    });
    return { name, total: entries.length, entries: entries.filter((entry) => matches(entry, query)) };
  });
  return { sections, masked };
}

function sectionCard(view: View, section: Shown, width: number, region: RenderElement, isFramed: boolean): RenderElement {
  const inner = Math.max(1, isFramed ? width - CARD_FRAME : width);
  const count = query.trim() === "" ? plural(section.total, "entry", "entries") : `${section.entries.length} of ${section.total}`;
  const title = view.kit.Button({
    key: titleKey(section.name),
    label: fitEnd(`${heading(section.name)} ${view.g.dot} ${count}`, inner, view.g.ellipsis),
    plain: true,
    ...(isFramed ? {} : { dimColor: true }),
    onPress: view.press(() => undefined),
  });
  if (!isFramed) return view.kit.Box({ key: `section-${section.name}`, flexDirection: "column", width, children: [title, region] });
  return Card(view.kit, { key: `section-${section.name}`, title, tone: TONES[section.name], isAscii: view.isAscii, width, children: [region] });
}

function sectionUnits(view: View, section: Shown, inner: number): Unit[] {
  if (section.entries.length === 0) {
    return [{ element: view.kit.Text({ dimColor: true, children: [fitEnd("Nothing recorded yet", inner, view.g.ellipsis)] }), rows: 1 }];
  }
  return section.entries.flatMap((entry, index) => [
    { element: Rule(view.kit, inner, view.g, view.isAscii, entry.at === null ? "undated" : formatWhen(entry.at)), rows: 1 },
    ...markdownUnits(view.kit, entry.text, inner, `note-${section.name}-${index}`),
  ]);
}

// Whole pieces go as the room shrinks: the masked count, then "entries" before "match".
function headerPieces(notepad: Notepad, view: View, entries: number, found: number, masked: number): Piece[] {
  const total = plural(entries, "entry", "entries");
  const isFinding = query.trim() !== "";
  const pieces = (count: string, isMaskedShown: boolean): Piece[] => [
    { text: notepad.planName, color: TONE_KEYS.plan, bold: true },
    { text: " " },
    notepad.bound === notepad.planName ? chip("BOUND", "plan", view.isAscii) : { text: "not bound", color: TONE_KEYS.muted },
    { text: ` ${view.g.dot} ${count}`, color: TONE_KEYS.muted },
    ...(isMaskedShown && masked > 0 ? [{ text: ` ${view.g.dot} ${masked} masked`, color: TONE_KEYS.warn }] : []),
  ];
  const long = isFinding ? `${found} of ${total} match` : total;
  const shortest = pieces(isFinding ? `${found} of ${entries} match` : total, false);
  const fitting = [pieces(long, true), pieces(long, false), shortest].find((one) => piecesWidth(one) <= view.width);
  return fitting ?? fitPieces(shortest, view.width, view.g.ellipsis);
}

type Key = readonly [hotkey: string, label: string, work: () => void];

function keys(host: Host, notepad: Notepad, view: View, canFind: boolean, isFinding: boolean): { element: RenderElement; width: number } {
  const find = () => {
    isSearching = true;
    host.ui.invalidate();
    refocus(host, FIND, "notepad");
  };
  const clear = () => {
    resetCards();
    query = "";
    isSearching = false;
    host.ui.invalidate();
  };
  const pick = () => {
    isPicking = true;
    host.ui.invalidate();
    refocus(host, `${PICK}${notepad.planName}`, "notepad");
  };
  // Clear shows with the field, not with a query, so typing never shifts the ring, which the engine holds by position.
  const buttons: Key[] = [
    ...(canFind ? [["f", "Find", find] as const] : []),
    ...(isFinding ? [["w", "Clear", clear] as const] : []),
    ...(notepad.plans.length > 1 ? [["l", `Plans (${notepad.plans.length})`, pick] as const] : []),
  ];
  return {
    width: buttons.reduce((sum, [hotkey, label]) => sum + displayWidth(`${hotkey}: ${label}`), 0) + KEY_GAP * Math.max(0, buttons.length - 1),
    element: view.kit.Box({
      key: "notepad-keys",
      flexDirection: "row",
      columnGap: KEY_GAP,
      children: buttons.map(([hotkey, label, work]) => keyButton(view, hotkey, label, work)),
    }),
  };
}

function field(host: Host, view: View): RenderElement {
  const search = (value: string) => {
    resetCards();
    query = value;
    host.ui.invalidate();
  };
  return Field(view.kit, {
    key: FIND,
    label: "Find",
    placeholder: fitEnd("find in entries", Math.max(1, view.width - 2), view.g.ellipsis),
    value: query,
    onInput: search,
    onSubmit: (value) => {
      search(value);
      isSearching = false;
    },
  });
}

// The engine empties a submitted field, so a query that outlives its Enter shows as a line.
const held = (view: View): RenderElement =>
  view.kit.Text({ wrap: "truncate-end", children: [fitEnd(`Find: ${query}`, view.width, view.g.ellipsis)] });

function picker(host: Host, notepad: Notepad, view: View): RenderElement[] {
  const { Box, Button, Text } = view.kit;
  return [
    Text({ dimColor: true, children: [fitEnd(`Notepads ${view.g.dot} ${notepad.plans.length} plans, the bound one first`, view.width, view.g.ellipsis)] }),
    ...notepad.plans.map((name) => {
      const isShown = name === notepad.planName;
      const lead = `${isShown ? view.g.pointer : " "} `;
      const mark = name === notepad.bound ? chip("BOUND", "plan", view.isAscii) : undefined;
      const room = view.width - displayWidth(lead) - (mark === undefined ? 0 : displayWidth(mark.text) + 1);
      return Box({
        key: `${PICK}row-${name}`,
        flexDirection: "row",
        children: [
          Text({ color: TONE_KEYS.active, children: [lead] }),
          Button({
            key: `${PICK}${name}`,
            label: fitEnd(name, Math.max(1, room), view.g.ellipsis),
            plain: true,
            ...(isShown ? { autoFocus: true } : {}),
            onPress: view.press(() => choose(host, name)),
          }),
          ...(mark === undefined ? [] : [Text({ children: [" "] }), Line(view.kit, [mark])]),
        ],
      });
    }),
    keyButton(view, "l", "Back", () => {
      isPicking = false;
      host.ui.invalidate();
    }),
  ];
}

type Slot = { section: Shown; units: Unit[]; need: number };

const unitRows = (units: readonly Unit[]) => units.reduce((sum, unit) => sum + unit.rows, 0);
const chromeOf = (isFramed: boolean) => (isFramed ? CARD_ROWS : HEADING_ROWS);

function slotsAt(view: View, sections: readonly Shown[], width: number, isFramed: boolean): Slot[] {
  const inner = Math.max(1, isFramed ? width - CARD_FRAME : width);
  return sections.map((section) => {
    const units = sectionUnits(view, section, inner);
    return { section, units, need: chromeOf(isFramed) + unitRows(units) };
  });
}

// The tallest card first, each next onto the shorter column: the tallest sits alone while the rest balance.
function divide(slots: readonly Slot[]): [Slot[], Slot[]] {
  const columns: [Slot[], Slot[]] = [[], []];
  const heights: [number, number] = [0, 0];
  for (const slot of slots.toSorted((a, b) => b.need - a.need)) {
    const at = heights[1] < heights[0] ? 1 : 0;
    columns[at].push(slot);
    heights[at] += slot.need;
  }
  const byOrder = (a: Slot, b: Slot) => NOTEPAD_SECTIONS.indexOf(a.section.name) - NOTEPAD_SECTIONS.indexOf(b.section.name);
  return [columns[0].toSorted(byOrder), columns[1].toSorted(byOrder)];
}

// Cards that fit keep their height and the rest share what remains evenly, the first taking an odd
// row; a card gets `least` rows even when that runs the stack past the room.
function shareRows(needs: readonly number[], available: number, least: number): number[] {
  const heights = needs.map(() => 0);
  let left = available;
  const order = needs.map((_, at) => at).sort((a, b) => (needs[a] ?? 0) - (needs[b] ?? 0));
  order.forEach((at, done) => {
    const need = needs[at] ?? 0;
    const height = Math.max(Math.min(need, Math.ceil(left / (order.length - done))), Math.min(need, least));
    heights[at] = height;
    left -= height;
  });
  return heights;
}

type Column = { slots: Slot[]; heights: number[] };
type Arranged = { columns: Column[]; width: number; isFramed: boolean };

const isCut = ({ columns }: Arranged) => columns.some(({ slots, heights }) => slots.some(({ need }, index) => (heights[index] ?? 0) < need));

// Two columns only where each can give every card its least rows; otherwise the cards stack.
function arrange(view: View, sections: readonly Shown[], available: number): Arranged {
  const isFramed = view.rows >= FRAMED_FROM;
  const chrome = chromeOf(isFramed);
  const sized = (slots: Slot[]): Column => ({
    slots,
    heights: shareRows(
      slots.map(({ need }) => need),
      available,
      chrome + MIN_CONTENT,
    ),
  });
  if (view.tier === "split" && sections.length > 1) {
    const width = Math.floor((view.width - COLUMN_GAP) / 2);
    const halves = divide(slotsAt(view, sections, width, isFramed));
    if (halves.every((slots) => slots.length * (chrome + MIN_CONTENT) <= available)) return { columns: halves.map(sized), width, isFramed };
  }
  return { columns: [sized(slotsAt(view, sections, view.width, isFramed))], width: view.width, isFramed };
}

function stack(view: View, { slots, heights }: Column, { width, isFramed }: Arranged, left: number, top: number): RenderElement[] {
  const chrome = chromeOf(isFramed);
  let at = top;
  return slots.map(({ section, units }, index) => {
    const height = heights[index] ?? chrome + 1;
    const region = ScrollRegion({
      kit: view.kit,
      g: view.g,
      key: cardKey(section.name),
      left: left + (isFramed ? CARD_INSET : 0),
      top: at + (isFramed ? CARD_INSET : HEADING_ROWS),
      width: Math.max(1, isFramed ? width - CARD_FRAME : width),
      height: height - chrome,
      units,
    });
    at += height;
    return sectionCard(view, section, width, region, isFramed);
  });
}

// Only the arrangement drawn lays out its regions, since each one a drawing lays out takes the wheel.
function draw(view: View, arranged: Arranged, above: number): RenderElement[] {
  const { columns, width } = arranged;
  const drawn = columns.map((column, index) => stack(view, column, arranged, index * (width + COLUMN_GAP), above));
  const [only] = drawn;
  if (drawn.length === 1 && only !== undefined) return only;
  return [
    view.kit.Box({
      key: "notepad-columns",
      flexDirection: "row",
      columnGap: COLUMN_GAP,
      children: drawn.map((cards, index) => view.kit.Box({ key: `notepad-column-${index}`, flexDirection: "column", width, children: cards })),
    }),
  ];
}

// While a search runs, a section with no match is left out. Otherwise sections with no entry are drawn
// only where every card fits, else folded into one line.
function cards(view: View, all: readonly Shown[], above: number): RenderElement[] {
  const sections = query.trim() === "" ? all : all.filter((section) => section.entries.length > 0);
  if (sections.length === 0) {
    return [view.kit.Text({ dimColor: true, children: [fitEnd(`No entry matches "${query.trim()}"`, view.width, view.g.ellipsis)] })];
  }
  const available = view.rows - above;
  const whole = arrange(view, sections, available);
  const empties = sections.filter((section) => section.entries.length === 0);
  if (empties.length === 0 || !isCut(whole)) return draw(view, whole, above);
  const names = empties.map((section) => heading(section.name)).join(", ");
  const filled = arrange(
    view,
    sections.filter((section) => section.entries.length > 0),
    available - 1,
  );
  return [...draw(view, filled, above), view.kit.Text({ dimColor: true, children: [fitEnd(`Nothing yet in ${names}`, view.width, view.g.ellipsis)] })];
}

/** Aims the scroll keys at the card whose title takes the ring, and at none elsewhere. */
export function focus(e: Input<"ui.focus">): void {
  const name = NOTEPAD_SECTIONS.find((section) => titleKey(section) === e.element);
  aimKeys(name === undefined ? undefined : cardKey(name));
}

export const view: TabView = async (host, view) => {
  const { Box } = view.kit;
  const pane = (await host.state.pane.get()).value;
  const words = { loading: "Reading the notepad", empty: "No plan has a notepad yet; a plan's agents add one with notepad_write." };
  if (pane === undefined) return [noticeRow(view, { kind: "loading" }, words)];
  if (pane.errors.notepad !== null) return [noticeRow(view, { kind: "error", reason: pane.errors.notepad }, words)];
  const { notepad } = pane;
  if (notepad === null) return [noticeRow(view, { kind: "empty" }, words)];
  if (isPicking && notepad.plans.length > 1) return picker(host, notepad, view);
  const { sections, masked } = shownSections(notepad, view);
  const entries = sections.reduce((sum, section) => sum + section.total, 0);
  const found = sections.reduce((sum, section) => sum + section.entries.length, 0);
  const head = headerPieces(notepad, view, entries, found, masked);
  if (entries === 0) {
    return [
      Line(view.kit, head),
      noticeRow(view, { kind: "empty" }, { ...words, empty: `The notepad for ${notepad.planName} is empty.` }),
      ...(notepad.plans.length > 1 ? [keys(host, notepad, view, false, false).element] : []),
    ];
  }
  const isFinding = isSearching || query !== "";
  const row = keys(host, notepad, view, true, isFinding);
  const isMerged = view.rows < FRAMED_FROM && piecesWidth(head) + KEY_GAP + row.width <= view.width;
  const top = isMerged
    ? [Box({ key: "notepad-head", flexDirection: "row", columnGap: KEY_GAP, children: [Line(view.kit, head), row.element] })]
    : [Line(view.kit, head), row.element];
  const finder = isSearching ? [field(host, view)] : query === "" ? [] : [held(view)];
  return [...top, ...finder, ...cards(view, sections, top.length + finder.length)];
};
