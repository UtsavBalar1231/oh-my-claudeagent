import type { RenderElement } from "claude-code";
import { isPlanName, matches, NOTEPAD_SECTIONS, type NotepadSection, parseEntries } from "../../src/core/notepad.ts";
import { BOULDER } from "../../src/core/omca-paths.ts";
import { clean } from "../../src/core/checkboxes.ts";
import { COLUMN_GAP, displayWidth, fitEnd, formatWhen } from "../../src/core/ui-kit.ts";
import { chip, fitPieces, type Piece, piecesWidth, redact, themeKey, type Tone, TONE_KEYS } from "../../src/core/visual.ts";
import type { Input } from "../dispatch.ts";
import { boundPlanOf, type Host, reason, type State } from "../host.ts";
import { buttonRow, keyButton, noticeRow, patchPane, refocus, refocusRemote, type TabView, type View } from "../pane.ts";
import { aimKeys, markdownUnits, resetOffset, ScrollRegion, type Unit } from "../regions.ts";
import { Field, isRemote, Line, Rule } from "../ui.ts";

type Notepad = NonNullable<State["pane"]["notepad"]>;

const NOTEPADS = ".omca/notepads";
const FIND = "notepad-find";
const PICK = "notepad-plan-";
const PAGE = "notepad-page";
const KEY_GAP = 2;
const rowKey = (name: NotepadSection) => `notepad-section-${name}`;
const TONES: Readonly<Record<NotepadSection, Tone>> = { learnings: "info", issues: "warn", decisions: "active", problems: "fail" };

type Ranked = { name: string; at: number };

let signature: string | undefined;
let ranking: { root: string; stamp: number; plans: Ranked[] } | undefined;
let chosen: string | undefined;
let query = "";
let isSearching = false;
let isPicking = false;
let opened: NotepadSection | undefined;

export const reset = (): void => {
  resetOffset(PAGE);
  signature = undefined;
  ranking = undefined;
  chosen = undefined;
  query = "";
  isSearching = false;
  isPicking = false;
  opened = undefined;
};

async function boundPlan(host: Host, root: string): Promise<{ name: string | undefined; seen: string }> {
  const path = `${root}/${BOULDER}`;
  if (!(await host.fs.exists(path))) return { name: undefined, seen: "" };
  const { mtimeMs } = await host.fs.stat(path);
  return { name: (await boundPlanOf(host))?.name, seen: `${mtimeMs}` };
}

// Every notepad, the most recently written first. A listing reports a directory's time as 0, so a
// notepad is as recent as its newest section file; one that cannot be listed counts as oldest. The
// server bumps `.omca/notepads` on every write, so the ranking is listed again only when that moves.
async function rankedNotepads(host: Host, root: string): Promise<Ranked[]> {
  const dir = `${root}/${NOTEPADS}`;
  const stamp = await host.fs.stat(dir).then(
    ({ mtimeMs }) => mtimeMs,
    () => undefined,
  );
  if (stamp !== undefined && ranking?.root === root && ranking.stamp === stamp) return ranking.plans;
  const found = (await host.fs.exists(dir)) ? (await host.fs.list(dir)).filter((entry) => entry.kind === "dir" && isPlanName(entry.name)) : [];
  const written = await Promise.all(
    found.map(async ({ name }) => {
      const files = await host.fs.list(`${dir}/${name}`).catch(() => []);
      return { name, at: Math.max(0, ...files.filter((file) => file.kind === "file").map((file) => file.mtimeMs)) };
    }),
  );
  const plans = written.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  ranking = stamp === undefined ? undefined : { root, stamp, plans };
  return plans;
}

// The bound plan first, then the most recently written.
async function notepadPlans(host: Host, root: string, bound: string | undefined): Promise<{ name: string; seen: string }[]> {
  const rest = (await rankedNotepads(host, root)).filter(({ name }) => name !== bound).map(({ name, at }) => ({ name, seen: `${at}` }));
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

async function choose(host: Host, view: View, name: string): Promise<void> {
  chosen = name;
  opened = undefined;
  isPicking = false;
  signature = undefined;
  const pad = await read(host, await host.session.root());
  if (pad !== undefined) {
    await patchPane(host, (pane) => ({ ...pane, notepad: pad.notepad, errors: { ...pane.errors, notepad: pad.error } }));
  }
  host.ui.invalidate();
  refocusRemote(host, view, "l", "notepad");
}

const heading = (name: NotepadSection) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

type Shown = { name: NotepadSection; total: number; masked: number; entries: { at: number | null; text: string }[] };

function shownSections(notepad: Notepad, view: View): Shown[] {
  return NOTEPAD_SECTIONS.map((name) => {
    let masked = 0;
    const entries = parseEntries(notepad.sections.find((section) => section.name === name)?.text ?? "").map((entry) => {
      const cleaned = redact(entry.text, view.home, view.g.mask);
      masked += cleaned.masked;
      return { at: entry.at, text: cleaned.text };
    });
    return { name, total: entries.length, masked, entries: entries.filter((entry) => matches(entry, query)) };
  });
}

const sum = (sections: readonly Shown[], of: (section: Shown) => number) => sections.reduce((total, section) => total + of(section), 0);

function sectionUnits(view: View, section: Shown, inner: number): Unit[] {
  if (section.entries.length === 0) {
    return [{ element: view.kit.Text({ dimColor: true, children: [fitEnd(`No entry matches "${query.trim()}"`, inner, view.g.ellipsis)] }), rows: 1 }];
  }
  return section.entries.flatMap((entry, index) => [
    { element: Rule(view.kit, inner, view.g, view.isAscii, entry.at === null ? "undated" : formatWhen(entry.at)), rows: 1 },
    ...markdownUnits(view.kit, entry.text, inner, `note-${section.name}-${index}`),
  ]);
}

const planPiece = (notepad: Notepad): Piece => ({ text: notepad.planName, color: TONE_KEYS.plan, bold: true });

// Whole pieces go as the room shrinks: the masked count, then "entries" before "match".
function headerPieces(view: View, lead: readonly Piece[], entries: number, found: number, masked: number): Piece[] {
  const total = plural(entries, "entry", "entries");
  const isFinding = query.trim() !== "";
  const pieces = (count: string, isMaskedShown: boolean): Piece[] => [
    ...lead,
    { text: ` ${view.g.dot} ${count}`, color: TONE_KEYS.muted },
    ...(isMaskedShown && masked > 0 ? [{ text: ` ${view.g.dot} ${masked} masked`, color: TONE_KEYS.warn }] : []),
  ];
  const long = isFinding ? `${found} of ${total} match` : total;
  const shortest = pieces(isFinding ? `${found} of ${entries} match` : total, false);
  const fitting = [pieces(long, true), pieces(long, false), shortest].find((one) => piecesWidth(one) <= view.width);
  return fitting ?? fitPieces(shortest, view.width, view.g.ellipsis);
}

type Key = readonly [hotkey: string, label: string, work: () => void];

function keyRow(view: View, buttons: readonly Key[]): RenderElement {
  return view.kit.Box({
    key: "notepad-keys",
    flexDirection: "row",
    columnGap: KEY_GAP,
    ...buttonRow(view),
    children: buttons.map(([hotkey, label, work]) => keyButton(view, hotkey, label, work)),
  });
}

// Clear shows with the field, not with a query, so typing never shifts the ring, which the engine holds by position.
function findKeys(host: Host, view: View): Key[] {
  const find = () => {
    isSearching = true;
    host.ui.invalidate();
    refocus(host, FIND, "notepad");
  };
  const clear = () => {
    resetOffset(PAGE);
    query = "";
    isSearching = false;
    host.ui.invalidate();
    refocusRemote(host, view, "f", "notepad");
  };
  return [["f", "Find", find], ...(isSearching || query !== "" ? [["w", "Clear", clear] as const] : [])];
}

function pickKeys(host: Host, notepad: Notepad): Key[] {
  const pick = () => {
    isPicking = true;
    host.ui.invalidate();
    refocus(host, `${PICK}${notepad.planName}`, "notepad");
  };
  return notepad.plans.length > 1 ? [["l", `Plans (${notepad.plans.length})`, pick]] : [];
}

function field(host: Host, view: View): RenderElement {
  const search = (value: string) => {
    resetOffset(PAGE);
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

const finder = (host: Host, view: View): RenderElement[] => (isSearching ? [field(host, view)] : query === "" ? [] : [held(view)]);

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
            onPress: view.press(() => choose(host, view, name)),
          }),
          ...(mark === undefined ? [] : [Text({ children: [" "] }), Line(view.kit, [mark])]),
        ],
      });
    }),
    keyButton(view, "l", "Back", () => {
      isPicking = false;
      host.ui.invalidate();
      refocusRemote(host, view, "l", "notepad");
    }),
  ];
}

function openPage(host: Host, view: View, name: NotepadSection): void {
  opened = name;
  resetOffset(PAGE);
  host.ui.invalidate();
  refocusRemote(host, view, "b", "notepad");
}

function closePage(host: Host, name: NotepadSection): void {
  opened = undefined;
  host.ui.invalidate();
  refocus(host, rowKey(name), "notepad");
}

// A remote surface strips a Button's children and sets its buttons apart, so there the label carries the date too.
function sectionRow(host: Host, view: View, section: Shown, isFirst: boolean): RenderElement {
  const { kit, g } = view;
  const name = heading(section.name);
  if (section.entries.length === 0) {
    const why = section.total === 0 ? "nothing recorded yet" : "no match";
    return kit.Text({ dimColor: true, children: [fitEnd(`${g.pending} ${name} ${g.dot} ${why}`, view.width, g.ellipsis)] });
  }
  const count = query.trim() === "" ? plural(section.total, "entry", "entries") : `${section.entries.length} of ${section.total} match`;
  const newest = Math.max(...section.entries.flatMap((entry) => (entry.at === null ? [] : [entry.at])));
  const date = Number.isFinite(newest) ? formatWhen(newest) : "";
  const mark = `${g.running} `;
  const label = `${name} ${g.dot} ${count}`;
  const room = view.width - displayWidth(mark);
  const isRemoteDrawing = isRemote(kit);
  const after = date === "" || isRemoteDrawing ? "" : `${" ".repeat(COLUMN_GAP)}${date}`;
  const tail = displayWidth(label) + displayWidth(after) <= room ? after : "";
  return kit.Box({
    flexDirection: "row",
    children: [
      kit.Text({ color: themeKey(TONES[section.name]), children: [mark] }),
      kit.Button({
        key: rowKey(section.name),
        label: fitEnd(isRemoteDrawing && date !== "" ? `${label} ${g.dot} ${date}` : label, Math.max(1, room - displayWidth(tail)), g.ellipsis),
        plain: true,
        ...(isFirst ? { autoFocus: true } : {}),
        onPress: view.press(() => openPage(host, view, section.name)),
      }),
      ...(tail === "" ? [] : [kit.Text({ color: TONE_KEYS.muted, children: [tail] })]),
    ],
  });
}

function page(host: Host, notepad: Notepad, view: View, section: Shown): RenderElement[] {
  const { kit, g } = view;
  const lead: Piece[] = [
    planPiece(notepad),
    { text: ` ${g.dot} `, color: TONE_KEYS.muted },
    { text: heading(section.name), color: themeKey(TONES[section.name]), bold: true },
  ];
  const head = Line(kit, headerPieces(view, lead, section.total, section.entries.length, section.masked));
  const keys = keyRow(view, [["b", "Back", () => closePage(host, section.name)], ...findKeys(host, view)]);
  const search = finder(host, view);
  const top = 1 + search.length;
  const units = sectionUnits(view, section, view.width);
  const body = ScrollRegion({ kit, g, key: PAGE, left: 0, top, width: view.width, height: view.rows - top - 1, units, layout: view.layout });
  // A remote surface scrolls the whole page, so its keys sit under the header rather than below a long body.
  return isRemote(kit) ? [head, keys, ...search, body] : [head, ...search, body, keys];
}

/** Aims the scroll keys at the open page, and at no region on the index. */
export function focus(_e: Input<"ui.focus">): void {
  aimKeys(opened === undefined ? undefined : PAGE);
}

export const view: TabView = async (host, view) => {
  const pane = (await host.state.pane.get()).value;
  const words = { loading: "Reading the notepad", empty: "No plan has a notepad yet; a plan's agents add one with notepad_write." };
  if (pane === undefined) return [noticeRow(view, { kind: "loading" }, words)];
  if (pane.errors.notepad !== null) return [noticeRow(view, { kind: "error", reason: pane.errors.notepad }, words)];
  const { notepad } = pane;
  if (notepad === null) return [noticeRow(view, { kind: "empty" }, words)];
  if (isPicking && notepad.plans.length > 1) return picker(host, notepad, view);
  const sections = shownSections(notepad, view);
  const open = sections.find((section) => section.name === opened);
  if (open !== undefined && open.total > 0) return page(host, notepad, view, open);
  opened = undefined;
  const entries = sum(sections, (section) => section.total);
  const lead: Piece[] = [planPiece(notepad), { text: " " }, notepad.bound === notepad.planName ? chip("BOUND", "plan", view.isAscii) : { text: "not bound", color: TONE_KEYS.muted }];
  const head = Line(view.kit, headerPieces(view, lead, entries, sum(sections, (section) => section.entries.length), sum(sections, (section) => section.masked)));
  if (entries === 0) {
    return [
      head,
      noticeRow(view, { kind: "empty" }, { ...words, empty: `The notepad for ${notepad.planName} is empty.` }),
      ...(notepad.plans.length > 1 ? [keyRow(view, pickKeys(host, notepad))] : []),
    ];
  }
  const first = sections.find((section) => section.entries.length > 0)?.name;
  return [
    head,
    keyRow(view, [...findKeys(host, view), ...pickKeys(host, notepad)]),
    ...finder(host, view),
    ...sections.map((section) => sectionRow(host, view, section, section.name === first)),
  ];
};
