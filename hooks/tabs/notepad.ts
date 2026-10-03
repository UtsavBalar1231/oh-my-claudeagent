import type { RenderElement } from "claude-code";
import { matches, NOTEPAD_SECTIONS, type NotepadSection, parseEntries } from "../../src/core/notepad.ts";
import { BOULDER } from "../../src/core/omca-paths.ts";
import { clean } from "../../src/core/checkboxes.ts";
import { chunks } from "../../src/core/plan-reader.ts";
import { displayWidth, fitEnd, formatWhen } from "../../src/core/ui-kit.ts";
import { chip, fitPieces, type Piece, redact, type Tone, TONE_KEYS } from "../../src/core/visual.ts";
import { boundPlanOf, type Host, reason, type State } from "../host.ts";
import { keyButton, noticeRow, patchPane, refocus, type TabView, type View } from "../pane.ts";
import { Card, Field, Line, Rule } from "../ui.ts";

type Notepad = NonNullable<State["pane"]["notepad"]>;

const NOTEPADS = ".omca/notepads";
// notepad_write refuses any other plan name, so a directory outside this shape is not a notepad.
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIND = "notepad-find";
const PICK = "notepad-plan-";
const KEY_GAP = 2;
const COLUMN_GAP = 1;
// A card's round border and its one-cell padding on each side.
const CARD_FRAME = 4;
const TONES: Readonly<Record<NotepadSection, Tone>> = { learnings: "info", issues: "warn", decisions: "active", problems: "fail" };
const SPLIT_COLUMNS: readonly (readonly NotepadSection[])[] = [
  ["learnings", "decisions"],
  ["issues", "problems"],
];

let signature: string | undefined;
let chosen: string | undefined;
let query = "";
let isSearching = false;
let isPicking = false;

export const reset = (): void => {
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
  const found = (await host.fs.exists(dir)) ? (await host.fs.list(dir)).filter((entry) => entry.kind === "dir" && PLAN_NAME.test(entry.name)) : [];
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

function sectionCard(view: View, section: Shown, width: number): RenderElement {
  const { Markdown, Text } = view.kit;
  const inner = Math.max(1, width - CARD_FRAME);
  const count = query.trim() === "" ? plural(section.total, "entry", "entries") : `${section.entries.length} of ${section.total}`;
  const body =
    section.entries.length === 0
      ? [Text({ dimColor: true, children: [fitEnd("Nothing recorded yet", inner, view.g.ellipsis)] })]
      : section.entries.flatMap((entry, index) => [
          Rule(view.kit, inner, view.g, view.isAscii, entry.at === null ? "undated" : formatWhen(entry.at)),
          ...chunks(entry.text).map((text, part) => Markdown({ key: `note-${section.name}-${index}-${part}`, text })),
        ]);
  return Card(view.kit, {
    key: `section-${section.name}`,
    title: fitEnd(`${heading(section.name)} ${view.g.dot} ${count}`, inner, view.g.ellipsis),
    tone: TONES[section.name],
    isAscii: view.isAscii,
    width,
    children: body,
  });
}

function header(notepad: Notepad, view: View, entries: number, found: number, masked: number): RenderElement {
  const count = query.trim() === "" ? plural(entries, "entry", "entries") : `${found} of ${plural(entries, "entry", "entries")} match`;
  const pieces: Piece[] = [
    { text: notepad.planName, color: TONE_KEYS.plan, bold: true },
    { text: " " },
    notepad.bound === notepad.planName ? chip("BOUND", "plan", view.isAscii) : { text: "not bound", color: TONE_KEYS.muted },
    { text: ` ${view.g.dot} ${count}`, color: TONE_KEYS.muted },
    ...(masked > 0 ? [{ text: ` ${view.g.dot} ${masked} masked`, color: TONE_KEYS.warn }] : []),
  ];
  return Line(view.kit, fitPieces(pieces, view.width, view.g.ellipsis));
}

function keys(host: Host, notepad: Notepad, view: View, canFind: boolean): RenderElement {
  const find = () => {
    isSearching = true;
    host.ui.invalidate();
    refocus(host, FIND, "notepad");
  };
  const clear = () => {
    query = "";
    isSearching = false;
    host.ui.invalidate();
  };
  const pick = () => {
    isPicking = true;
    host.ui.invalidate();
    refocus(host, `${PICK}${notepad.planName}`, "notepad");
  };
  const buttons = [
    ...(canFind ? [keyButton(view, "f", "Find", find)] : []),
    ...(query === "" ? [] : [keyButton(view, "w", "Clear", clear)]),
    ...(notepad.plans.length > 1 ? [keyButton(view, "l", `Plans (${notepad.plans.length})`, pick)] : []),
  ];
  return view.kit.Box({ key: "notepad-keys", flexDirection: "row", columnGap: KEY_GAP, children: buttons });
}

function field(host: Host, view: View): RenderElement {
  const search = (value: string) => {
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
      isSearching = value !== "";
    },
  });
}

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

// While a search runs, a section with no match is left out rather than drawn empty.
function cards(view: View, all: readonly Shown[]): RenderElement[] {
  const sections = query.trim() === "" ? all : all.filter((section) => section.entries.length > 0);
  if (sections.length === 0) {
    return [view.kit.Text({ dimColor: true, children: [fitEnd(`No entry matches "${query.trim()}"`, view.width, view.g.ellipsis)] })];
  }
  if (view.tier !== "split") return sections.map((section) => sectionCard(view, section, view.width));
  const width = Math.floor((view.width - COLUMN_GAP) / 2);
  return [
    view.kit.Box({
      key: "notepad-columns",
      flexDirection: "row",
      columnGap: COLUMN_GAP,
      children: SPLIT_COLUMNS.map((names, index) =>
        view.kit.Box({
          key: `notepad-column-${index}`,
          flexDirection: "column",
          width,
          children: names.flatMap((name) => {
            const section = sections.find((shown) => shown.name === name);
            return section === undefined ? [] : [sectionCard(view, section, width)];
          }),
        }),
      ),
    }),
  ];
}

export const view: TabView = async (host, view) => {
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
  if (entries === 0) {
    return [
      header(notepad, view, entries, found, masked),
      noticeRow(view, { kind: "empty" }, { ...words, empty: `The notepad for ${notepad.planName} is empty.` }),
      ...(notepad.plans.length > 1 ? [keys(host, notepad, view, false)] : []),
    ];
  }
  return [
    header(notepad, view, entries, found, masked),
    keys(host, notepad, view, true),
    ...(isSearching || query !== "" ? [field(host, view)] : []),
    ...cards(view, sections),
  ];
};
