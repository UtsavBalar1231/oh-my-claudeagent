import type { RenderElement } from "claude-code";
import { resolveBoundPlan } from "../../src/core/boulder.ts";
import { type Drawn, drawnAt, type FocusList, focusMove, placeWindow } from "../../src/core/list-window.ts";
import { homeDir, inferPlatform, type Platform, samePath, tildePath } from "../../src/core/path.ts";
import {
  CONTENTS_CAP,
  chunks,
  firstOpenTask,
  isReadable,
  type PlanFile,
  parsePlan,
  planTarget,
  plansDirectory,
  readable,
  recentPlans,
} from "../../src/core/plan-reader.ts";
import { displayWidth, fitEnd, fitMiddle, KEYS, keyHint } from "../../src/core/ui-kit.ts";
import type { Input, Phase } from "../dispatch.ts";
import type { Host, State } from "../host.ts";
import type { Subcommand } from "../omca-router.ts";
import {
  envOf,
  keyButton,
  noticeRow,
  open,
  PANE,
  patchPane,
  reason,
  regainFocus,
  rule,
  type TabView,
  type View,
} from "../pane.ts";

type Loaded = Extract<State["plan"], { pages: unknown }>;
type Mode = "contents" | "page" | "plans";
type List = "contents" | "plans";
type Key = readonly [hotkey: string, label: string, work: () => unknown, isOff?: boolean];

const ROW = "row-";
const PICK = "pick-";
const BOULDER = ".omca/state/boulder.json";
const UNRESOLVED_PLANS = "~/.claude/plans";
const MIN_LIST_ROWS = 3;
// Docked: title, meta, rule, two edge lines, rule, key row, hint line.
const DOCK_CHROME_ROWS = 8;
// Inline: the title line, two edge lines, the key row.
const INLINE_CHROME_ROWS = 4;
const DATE = 10;
const KEY_GAP = 3;
// Esc hands the keyboard to the prompt even when the pane refuses to close, and how soon the
// pane can take it back varies with load, so it asks at growing delays until it holds it.
const REGAIN_DELAYS_MS = [0, 50, 150, 400] as const;

let mode: Mode = "contents";
let cursor = 0;
let isCursorSet = false;
let page = 0;
let pick = 0;
let loadedFrom = "";
let drawn: { [L in List]?: Drawn } = {};
let planned: { list: List; start: number } | undefined;
let isRingOnRow = false;

const isLoaded = (plan: State["plan"] | undefined): plan is Loaded => plan !== undefined && "pages" in plan;

async function where(host: Host): Promise<{ platform: Platform; root: string; home: string; dir: string }> {
  const [root, env, settings] = await Promise.all([host.session.root(), envOf(host), host.settings.read()]);
  const home = homeDir(env) ?? "";
  const platform = inferPlatform(root, home);
  return { platform, root, home, dir: plansDirectory(platform, settings["plansDirectory"], root, env) ?? UNRESOLVED_PLANS };
}

function startCursor(plan: Pick<Loaded, "pages">): number {
  const listed = readable(plan).filter((index) => index < CONTENTS_CAP);
  const first = firstOpenTask(plan);
  return listed.includes(first) ? first : (listed.at(-1) ?? 0);
}

function keptCursor(plan: Pick<Loaded, "pages">, index: number): number {
  const listed = readable(plan).filter((at) => at < CONTENTS_CAP);
  return listed.find((at) => at >= index) ?? listed.at(-1) ?? 0;
}

export type Keyboard = {
  regain: () => Promise<void>;
  isHeld: () => Promise<boolean>;
  after: (ms: number, run: () => Promise<void>) => void;
  log: (text: string) => void;
};

export function regainKeyboard(keyboard: Keyboard, then: () => Promise<void>): void {
  const attempt = (index: number): void => {
    const delay = REGAIN_DELAYS_MS[index];
    if (delay === undefined) {
      keyboard.log(`omca plan could not take the keyboard back after ${REGAIN_DELAYS_MS.length} attempts`);
      return;
    }
    keyboard.after(delay, async () => {
      try {
        await keyboard.regain();
        if (await keyboard.isHeld()) await then();
        else attempt(index + 1);
      } catch (error) {
        keyboard.log(`omca plan could not take the keyboard back: ${reason(error)}`);
      }
    });
  };
  attempt(0);
}

function refocus(host: Host, key: string, isKeyboardLost = false): void {
  const focusRow = async () => {
    try {
      host.ui.invalidate();
      const { deny } = await host.ui.focus({ requestId: PANE, key });
      if (deny !== undefined) host.log(`omca plan could not refocus ${key}: ${deny}`);
    } catch (error) {
      host.log(`omca plan could not refocus ${key}: ${reason(error)}`);
    }
  };
  if (!isKeyboardLost) {
    host.clock.after(0, focusRow);
    return;
  }
  regainKeyboard(
    {
      regain: () => regainFocus(host),
      isHeld: async () => (await host.ui.panes()).some((pane) => pane.id === PANE && pane.isFocused),
      after: (ms, run) => void host.clock.after(ms, run),
      log: host.log,
    },
    focusRow,
  );
}

async function load(host: Host, path: string, keepPlace = false): Promise<void> {
  const { value: previous, version } = await host.state.plan.get();
  const readAt = await host.clock.now();
  const isSame = keepPlace && previous?.path === path && loadedFrom !== "";
  try {
    const { mtimeMs } = await host.fs.stat(path);
    const plan = parsePlan(await host.fs.read(path));
    if (!(await host.state.plan.set({ path, ...plan, readAt }, { ifVersion: version })).isSet) return;
    loadedFrom = `${path}:${mtimeMs}`;
    isCursorSet = true;
    if (!isSame) {
      mode = "contents";
      cursor = startCursor(plan);
      return;
    }
    if (mode === "page" && page >= plan.pages.length) mode = "contents";
    cursor = keptCursor(plan, cursor);
  } catch (error) {
    if (!(await host.state.plan.set({ path, error: reason(error), readAt }, { ifVersion: version })).isSet) return;
    loadedFrom = `${path}:failed`;
    if (!isSame || mode === "page") mode = "contents";
  }
}

async function listPlans(host: Host): Promise<void> {
  const { platform, home, dir } = await where(host);
  try {
    const files = (await host.fs.exists(dir)) ? recentPlans(await host.fs.list(dir), dir) : [];
    await patchPane(host, (pane) => ({ ...pane, plans: { dir, files }, errors: { ...pane.errors, plans: null } }));
    const current = (await host.state.plan.get()).value?.path;
    pick = Math.max(0, files.findIndex((file) => current !== undefined && samePath(platform, file.path, current)));
  } catch (error) {
    const failure = `Could not list ${tildePath(platform, dir, home)}: ${reason(error)}`;
    await patchPane(host, (pane) => ({ ...pane, plans: { dir, files: [] }, errors: { ...pane.errors, plans: failure } }));
  }
  mode = "plans";
}

async function boundPath(host: Host): Promise<string | undefined> {
  const path = `${await host.session.root()}/${BOULDER}`;
  try {
    if (!(await host.fs.exists(path))) return undefined;
    const bound = resolveBoundPlan(JSON.parse(await host.fs.read(path)), await host.session.id(), true);
    return "active_plan" in bound && bound.active_plan !== "" ? bound.active_plan : undefined;
  } catch (error) {
    host.log(`omca plan: ${BOULDER} unreadable: ${reason(error)}`);
    return undefined;
  }
}

async function showBound(host: Host): Promise<void> {
  const bound = await boundPath(host);
  if (bound === undefined) await listPlans(host);
  else await load(host, bound);
}

export async function sync(host: Host): Promise<void> {
  const plan = (await host.state.plan.get()).value;
  if (plan === undefined) {
    if (mode !== "plans") await showBound(host);
    return;
  }
  const seen = await host.fs.stat(plan.path).then(
    ({ mtimeMs }) => `${plan.path}:${mtimeMs}`,
    () => `${plan.path}:failed`,
  );
  if (seen !== loadedFrom) await load(host, plan.path, true);
}

export const command: Subcommand = async (host, e, args) => {
  if (args.trim() === "") await showBound(host);
  else {
    const { platform, root, home, dir } = await where(host);
    await load(host, planTarget(platform, args, home, root, dir));
  }
  const answer = await open(host, e, "plan");
  refocus(host, mode === "plans" ? `${PICK}${pick}` : `${ROW}${cursor}`);
  return answer;
};

function toContents(host: Host, isKeyboardLost = false): void {
  if (mode === "page") cursor = page;
  mode = "contents";
  host.ui.invalidate();
  refocus(host, `${ROW}${cursor}`, isKeyboardLost);
}

export async function back(host: Host): Promise<boolean> {
  const isBack = mode === "page" || (mode === "plans" && isLoaded((await host.state.plan.get()).value));
  if (isBack) toContents(host, true);
  return isBack;
}

function listOf(plan: Loaded): FocusList {
  const total = Math.min(plan.pages.length, CONTENTS_CAP);
  return { total, current: cursor, rows: readable(plan).filter((index) => index < total) };
}

function picksOf(files: readonly PlanFile[]): FocusList {
  return { total: files.length, current: pick, rows: files.map((_, index) => index) };
}

export async function focus(host: Host, e: Input<"ui.focus">): Promise<Phase<Input<"ui.focus">, { deny?: string }> | undefined> {
  const list: List | undefined = mode === "plans" ? "plans" : mode === "contents" ? "contents" : undefined;
  const prefix = list === "plans" ? PICK : ROW;
  const picked = list !== undefined && e.element?.startsWith(prefix) === true ? Number(e.element.slice(prefix.length)) : Number.NaN;
  isRingOnRow = Number.isInteger(picked);
  const last = list === undefined ? undefined : drawn[list];
  if (!isRingOnRow || list === undefined || last === undefined) return undefined;
  const [plan, pane] = await Promise.all([host.state.plan.get(), host.state.pane.get()]);
  const files = pane.value?.plans?.files;
  const focusList = list === "plans" ? (files === undefined ? undefined : picksOf(files)) : isLoaded(plan.value) ? listOf(plan.value) : undefined;
  if (focusList === undefined) return undefined;
  const move = focusMove(focusList, last, picked);
  if (move.kind === "wrap") return { answer: {} };
  planned = { list, start: move.start };
  if (list === "plans") pick = picked;
  else cursor = picked;
  host.ui.invalidate();
  return { event: { ...e, element: `${prefix}${move.landing}` } };
}

function place(host: Host, list: List, focusList: FocusList, size: number, key: (index: number) => string): number {
  const start = planned?.list === list ? planned.start : undefined;
  if (start !== undefined) planned = undefined;
  const placed = placeWindow(focusList, size, drawn[list], start);
  drawn = { ...drawn, [list]: drawnAt(focusList, placed.start, size) };
  if (placed.isRefocusNeeded && isRingOnRow) refocus(host, key(focusList.current));
  return placed.start;
}

const listRows = (view: View) =>
  Math.max(MIN_LIST_ROWS, view.rows - (view.isInline ? INLINE_CHROME_ROWS : DOCK_CHROME_ROWS));

function keyRow(view: View, keys: readonly Key[], gap: number): RenderElement {
  return view.kit.Box({
    flexDirection: "row",
    columnGap: gap,
    children: keys.map(([hotkey, label, work, isOff]) => keyButton(view, hotkey, label, work, isOff)),
  });
}

function frame(
  view: View,
  parts: { title: string; meta: string; shortMeta: string; above: string; below: string; rows: RenderElement[]; keys: readonly Key[]; hint: string },
): RenderElement[] {
  const { Box, Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const edge = (text: string) => Text({ dimColor: true, children: [text === "" ? " " : fitEnd(text, view.width, ellipsis)] });
  if (view.isInline) {
    const meta = ` ${view.g.dot} ${parts.shortMeta}`;
    const title = fitEnd(parts.title, Math.max(1, view.width - displayWidth(meta)), ellipsis);
    const keysWidth = parts.keys.reduce((sum, [hotkey, label]) => sum + displayWidth(`${hotkey}: ${label}`) + KEY_GAP, 0);
    const hint = fitEnd(parts.hint, view.width - keysWidth, ellipsis);
    return [
      Box({
        flexDirection: "row",
        children: [
          Text({ bold: true, children: [title] }),
          Text({ dimColor: true, children: [fitEnd(meta, view.width - displayWidth(title), ellipsis)] }),
        ],
      }),
      edge(parts.above),
      ...parts.rows,
      edge(parts.below),
      Box({
        flexDirection: "row",
        columnGap: KEY_GAP,
        children: [
          ...parts.keys.map(([hotkey, label, work, isOff]) => keyButton(view, hotkey, label, work, isOff)),
          Text({ dimColor: true, children: [hint === "" ? " " : hint] }),
        ],
      }),
    ];
  }
  return [
    Text({ bold: true, children: [fitEnd(parts.title, view.width, ellipsis)] }),
    Text({ dimColor: true, children: [parts.meta] }),
    rule(view),
    edge(parts.above),
    ...parts.rows,
    edge(parts.below),
    rule(view),
    keyRow(view, parts.keys, KEY_GAP),
    Text({ dimColor: true, children: [fitEnd(parts.hint, view.width, ellipsis)] }),
  ];
}

function pointerRow(view: View, key: string, isCurrent: boolean, child: RenderElement): RenderElement {
  const { Box, Text } = view.kit;
  return Box({
    key,
    flexDirection: "row",
    children: [Text({ bold: true, children: [isCurrent ? `${view.g.pointer} ` : "  "] }), child],
  });
}

const moveHint = (view: View, close: string) =>
  keyHint([[`${view.g.up}${view.g.down}`, "move"], ["enter", "open"], [KEYS.back, close]], view.g);

function contentsView(host: Host, view: View, plan: Loaded): RenderElement[] {
  const { Button, Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  if (!isCursorSet) {
    cursor = startCursor(plan);
    isCursorSet = true;
  }
  const list = listOf(plan);
  if (list.rows.length === 0) {
    return [noticeRow(view, { kind: "empty" }, { loading: "", empty: `${plan.title} has no sections to read.` })];
  }
  const size = listRows(view);
  const start = place(host, "contents", list, size, (index) => `${ROW}${index}`);
  const end = Math.min(list.total, start + size);
  const rows = plan.pages.slice(start, end).map((section, offset) => {
    const index = start + offset;
    const indent = "  ".repeat(Math.max(0, section.level - 2));
    const mark = section.task === undefined ? "" : section.task.done ? "[x] " : "[ ] ";
    const label = fitEnd(`${indent}${mark}${section.title}`, view.width - 2, ellipsis);
    const isCurrent = index === cursor;
    if (!isReadable(section)) return pointerRow(view, `line-${index}`, false, Text({ bold: true, children: [label] }));
    return pointerRow(
      view,
      `line-${index}`,
      isCurrent,
      Button({
        key: `${ROW}${index}`,
        label,
        plain: true,
        ...(section.task?.done === true ? { dimColor: true } : {}),
        ...(isCurrent ? { autoFocus: true } : {}),
        onPress: view.press(() => {
          mode = "page";
          page = index;
          host.ui.invalidate();
          refocus(host, KEYS.next);
        }),
      }),
    );
  });
  const progress = `${plan.done}/${plan.total} tasks done`;
  const lead = `${progress} ${view.g.dot} `;
  const hidden = plan.pages.length - list.total;
  const below = list.total - end;
  return frame(view, {
    title: plan.title,
    meta: `${lead}${fitMiddle(tildePath(view.platform, plan.path, view.home), view.width - displayWidth(lead), ellipsis)}`,
    shortMeta: progress,
    above: start > 0 ? `  ${view.g.up} ${start} more` : "",
    below:
      below > 0
        ? `  ${view.g.down} ${below} more`
        : hidden > 0
          ? `  ${hidden} more past the first ${CONTENTS_CAP}; page on with ${KEYS.next}`
          : "",
    rows,
    keys: [
      [KEYS.reload, "Reload", () => reload(host)],
      [KEYS.list, "Plans", () => showPlans(host)],
    ],
    hint: moveHint(view, "close"),
  });
}

async function reload(host: Host): Promise<void> {
  const plan = (await host.state.plan.get()).value;
  if (plan !== undefined) await load(host, plan.path, true);
  host.ui.invalidate();
}

async function showPlans(host: Host): Promise<void> {
  await listPlans(host);
  host.ui.invalidate();
  refocus(host, `${PICK}${pick}`);
}

function pageView(host: Host, view: View, plan: Loaded): RenderElement[] {
  const { Box, Markdown, Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const order = readable(plan);
  const position = order.indexOf(page);
  const section = plan.pages[page];
  const contents: Key = [KEYS.contents, "Contents", () => toContents(host)];
  if (section === undefined || position < 0) {
    return [
      Text({ bold: true, children: [fitEnd(plan.title, view.width, ellipsis)] }),
      noticeRow(view, { kind: "empty" }, { loading: "", empty: "That section is gone after a reload." }),
      keyRow(view, [contents], KEY_GAP),
    ];
  }
  const step = (delta: number) => () => {
    const index = order[position + delta];
    if (index === undefined) return;
    page = index;
    host.ui.invalidate();
  };
  const counter = `${position + 1} / ${order.length}`;
  const mark = section.task === undefined ? "" : section.task.done ? "[x] " : "[ ] ";
  const body =
    section.body === ""
      ? [Text({ dimColor: true, children: ["No details under this task."] })]
      : chunks(section.body).map((text, part) => Markdown({ key: `md-${page}-${part}`, text }));
  return [
    Box({
      flexDirection: "row",
      children: [
        Text({ dimColor: true, children: [fitEnd(plan.title, Math.max(1, view.width - counter.length - 1), ellipsis)] }),
        Box({ flexGrow: 1 }),
        Text({ dimColor: true, children: [counter] }),
      ],
    }),
    keyRow(
      view,
      [
        contents,
        [KEYS.prev, "Prev", step(-1), position === 0],
        [KEYS.next, "Next", step(1), position === order.length - 1],
        [KEYS.reload, "Reload", () => reload(host)],
      ],
      2,
    ),
    rule(view),
    Text({ bold: true, wrap: "wrap", children: [`${mark}${section.title}`] }),
    Text({ children: [" "] }),
    ...body,
    Text({ children: [" "] }),
    Text({ dimColor: true, children: [keyHint([[`${view.g.up}${view.g.down}`, "scroll"], [KEYS.back, "contents"]], view.g)] }),
  ];
}

function plansView(host: Host, view: View, pane: State["pane"] | undefined, plan: State["plan"] | undefined): RenderElement[] {
  const { Box, Button, Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const hasPlan = isLoaded(plan);
  const words = { loading: "Listing the plans", empty: "" };
  const keys: Key[] = [
    ...(hasPlan ? [[KEYS.contents, "Contents", () => toContents(host)] as const] : []),
    [KEYS.reload, "Reload", () => showPlans(host)],
  ];
  const listing = pane?.plans;
  if (pane === undefined || listing === undefined || listing === null) return [noticeRow(view, { kind: "loading" }, words)];
  if (pane.errors.plans !== null) {
    return [noticeRow(view, { kind: "error", reason: pane.errors.plans }, words), keyRow(view, keys, KEY_GAP)];
  }
  const dir = tildePath(view.platform, listing.dir, view.home);
  if (listing.files.length === 0) {
    const lead = plan === undefined ? "No plan is bound to this session. No plans in " : "No plans in ";
    const empty = `${lead}${fitMiddle(dir, view.width - displayWidth(lead) - 1, ellipsis)}.`;
    return [noticeRow(view, { kind: "empty" }, { ...words, empty }), keyRow(view, keys, KEY_GAP)];
  }
  const list = picksOf(listing.files);
  const size = listRows(view);
  const start = place(host, "plans", list, size, (index) => `${PICK}${index}`);
  const end = Math.min(list.total, start + size);
  const rows = listing.files.slice(start, end).map((file, offset) => {
    const index = start + offset;
    const date = new Date(file.mtimeMs);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return pointerRow(
      view,
      `file-${index}`,
      index === pick,
      Box({
        flexDirection: "row",
        flexGrow: 1,
        children: [
          Button({
            key: `${PICK}${index}`,
            label: fitEnd(file.name, Math.max(1, view.width - 2 - DATE - 2), ellipsis),
            plain: true,
            ...(index === pick ? { autoFocus: true } : {}),
            onPress: view.press(async () => {
              await load(host, file.path);
              host.ui.invalidate();
              refocus(host, `${ROW}${cursor}`);
            }),
          }),
          Box({ flexGrow: 1 }),
          Text({ dimColor: true, children: [day] }),
        ],
      }),
    );
  });
  const count = `${listing.files.length} most recent`;
  const lead = `${count} in `;
  return frame(view, {
    title: "Plans",
    meta: `${lead}${fitMiddle(dir, view.width - displayWidth(lead), ellipsis)}`,
    shortMeta: `${listing.files.length} recent`,
    above: start > 0 ? `  ${view.g.up} ${start} more` : "",
    below: end < list.total ? `  ${view.g.down} ${list.total - end} more` : "",
    rows,
    keys,
    hint: moveHint(view, hasPlan ? "back" : "close"),
  });
}

function errorView(host: Host, view: View, plan: Extract<State["plan"], { error: string }>): RenderElement[] {
  const lead = "Could not read ";
  const path = fitMiddle(tildePath(view.platform, plan.path, view.home), view.width - 2 - lead.length, view.g.ellipsis);
  return [
    noticeRow(view, { kind: "error", reason: `${lead}${path}` }, { loading: "", empty: "" }),
    view.kit.Text({ dimColor: true, children: [fitEnd(plan.error, view.width, view.g.ellipsis)] }),
    keyRow(
      view,
      [
        [KEYS.reload, "Reload", () => reload(host)],
        [KEYS.list, "Plans", () => showPlans(host)],
      ],
      KEY_GAP,
    ),
  ];
}

export const view: TabView = async (host, view) => {
  const [plan, pane] = await Promise.all([host.state.plan.get(), host.state.pane.get()]);
  if (mode === "plans") return plansView(host, view, pane.value, plan.value);
  if (plan.value === undefined) {
    return [noticeRow(view, { kind: "loading" }, { loading: "Reading the plan", empty: "" })];
  }
  if (!isLoaded(plan.value)) return errorView(host, view, plan.value);
  return mode === "page" ? pageView(host, view, plan.value) : contentsView(host, view, plan.value);
};
