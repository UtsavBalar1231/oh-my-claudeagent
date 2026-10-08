import type { RenderElement } from "claude-code";
import { type Drawn, drawnAt, type FocusList, focusMove, placeWindow, windowOf } from "../../src/core/list-window.ts";
import { BOULDER } from "../../src/core/omca-paths.ts";
import { type Platform, samePath, tildePath } from "../../src/core/path.ts";
import {
  type Board,
  boardOf,
  type Card,
  CONTENTS_CAP,
  firstOpenTask,
  isReadable,
  type Page,
  type PlanFile,
  parsePlan,
  planTarget,
  plansDirectory,
  readable,
  recentPlans,
  taskMarkdown,
} from "../../src/core/plan-reader.ts";
import { ago, type Proof, proofSummary, type Run, timeAgo, type Verdict } from "../../src/core/proof.ts";
import { agentGlyph, dayOf, displayWidth, fitEnd, fitMiddle, KEYS, keyHint, padStart, shortType, wrapText } from "../../src/core/ui-kit.ts";
import {
  agentKey,
  bar,
  chip,
  type ChipTone,
  fitPieces,
  type Level,
  levelMark,
  ON_SURFACE,
  type Piece,
  piecesWidth,
  redact,
  rule as rulePieces,
  type ThemeKey,
  TONE_KEYS,
} from "../../src/core/visual.ts";
import type { Input, Phase } from "../dispatch.ts";
import { boundPlanOf, type Host, type ProofFacts, proofFacts, reason, sessionOf, type State, verdictFor } from "../host.ts";
import type { Subcommand } from "../omca-router.ts";
import { blanks, edge, keyButton, noticeRow, open, PANE, patchPane, refocus as focusIn, rule, type TabView, type View, wrapAt } from "../pane.ts";
import { codeUnits, markdownUnits, resetOffset, ScrollRegion, scrollKeyed, type Unit } from "../regions.ts";
import { Card as CardBox, Field, Line } from "../ui.ts";

type Loaded = Extract<State["plan"], { pages: unknown }>;
type Agent = State["agents"][string];
type Mode = "board" | "detail" | "contents" | "page" | "plans";
type List = "board" | "contents" | "plans";
type Key = readonly [hotkey: string, label: string, work: () => unknown, isOff?: boolean];
type Status = "done" | "progress" | "blocked" | "open";
type Item = { kind: "group"; group: number; done: number; total: number } | { kind: "task"; card: Card };
type Ring = {
  focus: FocusList;
  keyOf: (index: number) => string;
  indexOf: (element: string) => number | undefined;
  select: (index: number) => void;
};
type Filter = { text: string; isOpenOnly: boolean; isFailingOnly: boolean; isEditing: boolean };
type Ctx = {
  plan: Loaded;
  board: Board;
  byN: ReadonlyMap<number, Card>;
  running: ReadonlyMap<number, readonly Agent[]>;
  agents: readonly Agent[];
};

const ROW = "row-";
const PICK = "pick-";
const TASK = "task-";
const FILTER = "filter";
const UNRESOLVED_PLANS = "~/.claude/plans";
const MIN_LIST_ROWS = 3;
// Docked and full: title, meta, rule, two edge lines, rule, hint line, then the key rows.
const FULL_CHROME_ROWS = 7;
// Otherwise: the title line, two edge lines, then the key rows.
const COMPACT_CHROME_ROWS = 3;
const DATE = 10;
const KEY_GAP = 3;
const BOARD_KEY_GAP = 2;
const TWO_KEY_ROWS_FROM = 30;
// Below this many rows the header is one line and the hint line goes.
const SHORT_ROWS = 12;
// A docked board shorter than this draws its header as two plain lines instead of a card.
const CARD_FROM_ROWS = 24;
// The title and three lines inside the card's two borders; a fourth line when agents run.
const CARD_ROWS = 6;
const EXPANSION_MIN = 2;
const NEIGHBOURS = 2;
const LEAN_ROWS = 4;
const TITLE_SHARE = 0.4;
const MIN_TITLE = 12;
const SPLIT_FROM_ROWS = 14;
const SPLIT_MIN_LIST = 56;
const SPLIT_MIN_DETAIL = 32;
const SPLIT_SHARE = 0.65;
const PAGE_REGION = "page-region";
const HEADER_BAR = 24;
const COMPACT_BAR = 10;
const EVIDENCE_SHOWN = 3;
const DETAIL = "board-detail-region";
const UNREADABLE = "None of its files can be read, so no run can prove it.";

const STATUS: Readonly<Record<Status, { word: string; tone: ChipTone; color: ThemeKey | undefined }>> = {
  done: { word: "DONE", tone: "ok", color: TONE_KEYS.ok },
  progress: { word: "IN PROGRESS", tone: "active", color: TONE_KEYS.active },
  blocked: { word: "BLOCKED", tone: "warn", color: TONE_KEYS.warn },
  open: { word: "OPEN", tone: "muted", color: undefined },
};

const PROOF: Readonly<Record<Proof, { word: string; tone: ChipTone; level: Level }>> = {
  proven: { word: "PROVEN", tone: "ok", level: "ok" },
  unproven: { word: "UNPROVEN", tone: "warn", level: "warn" },
  failed: { word: "FAILED", tone: "fail", level: "fail" },
};

let mode: Mode = "board";
let cursor = 0;
let isCursorSet = false;
let task = 0;
let page = 0;
let pick = 0;
let loadedFrom = "";
let drawn: { [L in List]?: Drawn } = {};
let planned: { list: List; start: number } | undefined;
let isRingOnRow = false;
let filter: Filter = { text: "", isOpenOnly: false, isFailingOnly: false, isEditing: false };
let note: { text: string; level: Level } | undefined;
let facts: ProofFacts = { changes: new Map(), proving: [], ledgerError: null, ledgerSeen: "" };
let factsSignature = "";
let memo: { key: string; board: Board } | undefined;
let detailShown: number | undefined;
let pageShown = "";
// A narrowed list with little room draws no milestone headings; the cursor's ring reads the same items.
let isLean = false;
// Whether the latest drawing windowed its list: it then ends in one blank row past the body, which
// keeps the arrows and the wheel on this tab's own scroll.
let isCut = false;
let tallies: ReadonlyMap<string, string> = new Map();
let boundTo: string | undefined;
// The engine holds the ring by position, so a refocus sent while the Find field is still drawn
// lands one element off once the field goes; it is sent from the first drawing without it.
let isFieldClosing = false;

const markOf = ({ task: mark }: Page) => (mark === undefined ? "" : mark.done ? "[x] " : "[ ] ");

const isLoaded = (plan: State["plan"] | undefined): plan is Loaded => plan !== undefined && "pages" in plan;

function boardFor(plan: Loaded): Board {
  const key = `${plan.path}:${plan.readAt}`;
  if (memo?.key !== key) memo = { key, board: boardOf(plan) };
  return memo.board;
}

async function where(host: Host): Promise<{ platform: Platform; root: string; home: string; dir: string }> {
  const [root, { env, platform, home }, settings] = await Promise.all([
    host.session.root(),
    sessionOf(host),
    host.settings.read(),
  ]);
  return { platform, root, home, dir: plansDirectory(platform, settings["plansDirectory"], root, env) ?? UNRESOLVED_PLANS };
}

/** The plans `/omca plan <name>` can name, newest first, as the picker lists them. */
export async function planNames(host: Host): Promise<string[]> {
  const { dir } = await where(host);
  return (await host.fs.exists(dir)) ? recentPlans(await host.fs.list(dir), dir).map((file) => file.name) : [];
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

const startTask = (board: Board): number => (board.cards.find((card) => !card.done) ?? board.cards.at(-1))?.n ?? 0;

const refocus = (host: Host, key: string): void => focusIn(host, key, "plan");

// The tick yields to any write that lands while it reads, so it never reverts a choice a person
// made meanwhile; a person's own load always lands.
type Load = { keepPlace?: boolean; isTick?: boolean };

async function load(host: Host, path: string, { keepPlace = false, isTick = false }: Load = {}): Promise<void> {
  const { value: previous, version } = await host.state.plan.get();
  const readAt = await host.clock.now();
  const isSame = keepPlace && previous?.path === path && loadedFrom !== "";
  const written = (value: State["plan"]) => host.state.plan.set(value, isTick ? { ifVersion: version } : undefined);
  try {
    const { mtimeMs } = await host.fs.stat(path);
    const plan = parsePlan(await host.fs.read(path));
    if (!(await written({ path, ...plan, readAt })).isSet) return;
    loadedFrom = `${path}:${mtimeMs}`;
    isCursorSet = true;
    const board = boardOf(plan);
    const home: Mode = board.cards.length > 0 ? "board" : "contents";
    if (!isSame) {
      mode = home;
      cursor = startCursor(plan);
      task = startTask(board);
      filter = { text: "", isOpenOnly: false, isFailingOnly: false, isEditing: false };
      return;
    }
    if (mode === "page" && page >= plan.pages.length) mode = "contents";
    if ((mode === "board" || mode === "detail") && !board.cards.some((card) => card.n === task)) task = startTask(board);
    if (home === "contents" && (mode === "board" || mode === "detail")) mode = "contents";
    cursor = keptCursor(plan, cursor);
  } catch (error) {
    if (!(await written({ path, error: reason(error), readAt })).isSet) return;
    loadedFrom = `${path}:failed`;
    if (!isSame || mode === "page" || mode === "detail") mode = "contents";
  }
}

// Every listed file's modification time and the ledger's runs, read outside any drawing.
async function gather(host: Host, plan: Loaded, within?: object): Promise<void> {
  const next = await proofFacts(host, boardFor(plan).cards.flatMap((card) => card.files), within);
  const signature = JSON.stringify([[...next.changes], next.ledgerSeen, next.ledgerError]);
  if (signature === factsSignature) return;
  facts = next;
  factsSignature = signature;
  host.ui.invalidate();
}

async function listPlans(host: Host): Promise<void> {
  const { platform, home, dir } = await where(host);
  try {
    const files = (await host.fs.exists(dir)) ? recentPlans(await host.fs.list(dir), dir) : [];
    await patchPane(host, (pane) => ({ ...pane, plans: { dir, files }, errors: { ...pane.errors, plans: null } }));
    const counts = await Promise.all(
      files.map(async (file) => {
        const text = await host.fs.read(file.path).then(
          (source) => parsePlan(source),
          () => undefined,
        );
        return [file.path, text === undefined || text.total === 0 ? "" : `${text.done}/${text.total}`] as const;
      }),
    );
    tallies = new Map(counts.filter(([, count]) => count !== ""));
    boundTo = await boundPath(host);
    const current = (await host.state.plan.get()).value?.path;
    pick = Math.max(0, files.findIndex((file) => current !== undefined && samePath(platform, file.path, current)));
  } catch (error) {
    tallies = new Map();
    const failure = `Could not list ${tildePath(platform, dir, home)}: ${reason(error)}`;
    await patchPane(host, (pane) => ({ ...pane, plans: { dir, files: [] }, errors: { ...pane.errors, plans: failure } }));
  }
  mode = "plans";
}

async function boundPath(host: Host): Promise<string | undefined> {
  try {
    return (await boundPlanOf(host))?.path;
  } catch (error) {
    host.log(`omca plan: ${BOULDER} unreadable: ${reason(error)}`);
    return undefined;
  }
}

async function showBound(host: Host, isTick = false): Promise<void> {
  const bound = await boundPath(host);
  if (bound === undefined) await listPlans(host);
  else await load(host, bound, { isTick });
}

/** `within` is the event of the dispatch that syncs, shared with the band's read of the same files. */
export async function sync(host: Host, within?: object): Promise<void> {
  const plan = (await host.state.plan.get()).value;
  if (plan === undefined) {
    if (mode !== "plans") await showBound(host, true);
  } else {
    const seen = await host.fs.stat(plan.path).then(
      ({ mtimeMs }) => `${plan.path}:${mtimeMs}`,
      () => `${plan.path}:failed`,
    );
    if (seen !== loadedFrom) await load(host, plan.path, { keepPlace: true, isTick: true });
  }
  const current = (await host.state.plan.get()).value;
  if (isLoaded(current)) await gather(host, current, within);
}

const rowKey = () => (mode === "plans" ? `${PICK}${pick}` : mode === "board" ? `${TASK}${task}` : `${ROW}${cursor}`);

export const command: Subcommand = async (host, e, args) => {
  if (args.trim() === "") await showBound(host);
  else {
    const { platform, root, home, dir } = await where(host);
    await load(host, planTarget(platform, args, home, root, dir));
  }
  const answer = await open(host, e, "plan");
  refocus(host, rowKey());
  return answer;
};

function toContents(host: Host): void {
  if (mode === "page") cursor = page;
  mode = "contents";
  host.ui.invalidate();
  refocus(host, `${ROW}${cursor}`);
}

function toBoard(host: Host): void {
  mode = "board";
  note = undefined;
  host.ui.invalidate();
  refocus(host, `${TASK}${task}`);
}

const verdictOf = (card: Card): Verdict | undefined => verdictFor(facts, card.files);

function runningOf(agents: readonly Agent[]): Map<number, Agent[]> {
  const running = new Map<number, Agent[]>();
  for (const agent of agents) {
    if (agent.endedAt === null && agent.task !== undefined) running.set(agent.task, [...(running.get(agent.task) ?? []), agent]);
  }
  return running;
}

function statusOf(ctx: Pick<Ctx, "byN" | "running">, card: Card): Status {
  if (card.done) return "done";
  if (ctx.running.has(card.n)) return "progress";
  return card.depends.some((n) => ctx.byN.get(n)?.done !== true) ? "blocked" : "open";
}

const waitingOn = (ctx: Pick<Ctx, "byN">, card: Card) => card.depends.filter((n) => ctx.byN.get(n)?.done !== true);

const glyphOf = (view: View, status: Status) =>
  ({ done: view.g.check, progress: view.g.progress, blocked: view.g.blocked, open: view.g.pending })[status];

function isShown(card: Card): boolean {
  if (filter.isOpenOnly && card.done) return false;
  if (filter.isFailingOnly && verdictOf(card)?.proof !== "failed") return false;
  const wanted = filter.text.trim().toLowerCase();
  return wanted === "" || `${card.n} ${card.title} ${card.files.join(" ")}`.toLowerCase().includes(wanted);
}

const isFiltered = () => filter.text.trim() !== "" || filter.isOpenOnly || filter.isFailingOnly;

function itemsOf(board: Board): Item[] {
  return board.groups.flatMap((group, index) => {
    const cards = board.cards.filter((card) => card.group === index);
    const shown = cards.filter(isShown);
    if (shown.length === 0) return [];
    const done = cards.filter((card) => card.done).length;
    const tasks = shown.map((card) => ({ kind: "task" as const, card }));
    return isLean ? tasks : [{ kind: "group" as const, group: index, done, total: group.tasks.length }, ...tasks];
  });
}

const taskIndices = (items: readonly Item[]) => items.flatMap((item, index) => (item.kind === "task" ? [index] : []));

const taskAt = (items: readonly Item[], index: number) => {
  const item = items[index];
  return item?.kind === "task" ? item.card : undefined;
};

// The cursor stays on its task while the task is shown, else moves to the next shown one.
function cursorIndex(items: readonly Item[]): number {
  const tasks = taskIndices(items);
  const exact = tasks.find((index) => taskAt(items, index)?.n === task);
  const at = exact ?? tasks.find((index) => (taskAt(items, index)?.n ?? 0) > task) ?? tasks.at(-1);
  const card = at === undefined ? undefined : taskAt(items, at);
  if (card !== undefined) task = card.n;
  return at ?? 0;
}

function listOf(plan: Loaded): FocusList {
  const total = Math.min(plan.pages.length, CONTENTS_CAP);
  return { total, current: cursor, rows: readable(plan).filter((index) => index < total) };
}

function picksOf(files: readonly PlanFile[]): FocusList {
  return { total: files.length, current: pick, rows: files.map((_, index) => index) };
}

function boardList(items: readonly Item[]): FocusList {
  return { total: items.length, current: cursorIndex(items), rows: taskIndices(items) };
}

async function ringOf(host: Host, list: List): Promise<Ring | undefined> {
  const [plan, pane] = await Promise.all([host.state.plan.get(), host.state.pane.get()]);
  const numbered = (prefix: string, element: string) => {
    const value = element.startsWith(prefix) ? Number(element.slice(prefix.length)) : Number.NaN;
    return Number.isInteger(value) ? value : undefined;
  };
  if (list === "plans") {
    const files = pane.value?.plans?.files;
    if (files === undefined) return undefined;
    return {
      focus: picksOf(files),
      keyOf: (index) => `${PICK}${index}`,
      indexOf: (element) => numbered(PICK, element),
      select: (index) => void (pick = index),
    };
  }
  if (!isLoaded(plan.value)) return undefined;
  if (list === "contents") {
    return {
      focus: listOf(plan.value),
      keyOf: (index) => `${ROW}${index}`,
      indexOf: (element) => numbered(ROW, element),
      select: (index) => void (cursor = index),
    };
  }
  const items = itemsOf(boardFor(plan.value));
  return {
    focus: boardList(items),
    keyOf: (index) => `${TASK}${taskAt(items, index)?.n ?? task}`,
    indexOf: (element) => {
      const n = numbered(TASK, element);
      const index = items.findIndex((item) => item.kind === "task" && item.card.n === n);
      return index < 0 ? undefined : index;
    },
    select: (index) => void (task = taskAt(items, index)?.n ?? task),
  };
}

const listShown = (): List | undefined => (mode === "plans" || mode === "contents" || mode === "board" ? mode : undefined);

export async function focus(host: Host, e: Input<"ui.focus">): Promise<Phase<Input<"ui.focus">, { deny?: string }> | undefined> {
  const list = listShown();
  const ring = list === undefined ? undefined : await ringOf(host, list);
  const picked = ring === undefined || e.element === undefined ? undefined : ring.indexOf(e.element);
  isRingOnRow = picked !== undefined;
  const last = list === undefined ? undefined : drawn[list];
  if (list === undefined || ring === undefined || picked === undefined || last === undefined) return undefined;
  const move = focusMove(ring.focus, last, picked);
  if (move.kind === "wrap") return { answer: {} };
  planned = { list, start: move.start };
  ring.select(picked);
  note = undefined;
  host.ui.invalidate();
  return { event: { ...e, element: ring.keyOf(move.landing) } };
}

// The lists draw their own window, so the engine has nothing to scroll for these keys. A page key
// asks for `bodyRows`, Home and End for `contentRows`; where the two are equal the key is read as a page key.
// Anything shorter than a page is a wheel tick, which moves the cursor by its rows as the arrows do.
export async function scroll(host: Host, e: Input<"ui.scroll">): Promise<boolean> {
  const list = listShown();
  const last = list === undefined ? undefined : drawn[list];
  const isPage = Math.abs(e.by) === e.bodyRows;
  const isEnd = !isPage && Math.abs(e.by) === e.contentRows;
  const isTick = !isPage && !isEnd && Math.abs(e.by) < e.bodyRows;
  if (list === undefined && (mode === "detail" || mode === "page") && e.pointer === undefined) {
    if (!scrollKeyed(e.by, isPage ? "page" : isEnd ? "end" : "row")) return false;
    host.ui.invalidate();
    return true;
  }
  if (list === undefined || last === undefined || (!isPage && !isEnd && !isTick)) return false;
  const ring = await ringOf(host, list);
  if (ring === undefined || ring.focus.rows.length === 0) return false;
  const { rows, total, current } = ring.focus;
  const shown = rows.filter((index) => index >= last.start && index < last.start + last.size).length;
  const at = Math.max(0, rows.indexOf(current));
  const step = isTick ? e.by : Math.sign(e.by) * Math.max(1, shown);
  const to = isEnd ? (e.by > 0 ? rows.length - 1 : 0) : Math.max(0, Math.min(rows.length - 1, at + step));
  const target = rows[to] ?? current;
  if (target === current) return true;
  // An arrow takes the ring to the next drawn task the way a person's move does, so focus places
  // the window and the ring together; the engine keeps the ring by position, and a keyed refocus
  // after the window moved would land a row off.
  const isDrawn = target >= last.start && target < last.start + last.size;
  if (e.pointer === undefined && Math.abs(e.by) === 1 && isDrawn) {
    const { deny } = await host.ui.focus({ requestId: PANE, key: ring.keyOf(target) });
    if (deny === undefined) return true;
  }
  ring.select(target);
  planned = { list, start: windowOf(total, target, last.size).start };
  host.ui.invalidate();
  refocus(host, ring.keyOf(target));
  return true;
}

function place(host: Host, list: List, focusList: FocusList, size: number, key: (index: number) => string): number {
  const start = planned?.list === list ? planned.start : undefined;
  if (start !== undefined) planned = undefined;
  const placed = placeWindow(focusList, size, drawn[list], start);
  drawn = { ...drawn, [list]: drawnAt(focusList, placed.start, size) };
  if (placed.isRefocusNeeded && isRingOnRow) refocus(host, key(focusList.current));
  return placed.start;
}

const roomFor = (view: View, chrome: number): number => Math.max(1, view.rows - chrome);

const bareKey = ([hotkey, , work, ...off]: Key): Key => [hotkey, "", work, ...off];

const keyCells = ([hotkey, label]: Key) => displayWidth(`${hotkey}: ${label}`);

const shortKey = ([hotkey, label, work, ...off]: Key): Key => [hotkey, label.split(" ")[0] ?? label, work, ...off];

// Keys that do not fit the rows a pane this tall may spend on them keep only their label's first
// word, and past that lose their labels, last first.
function keyLayout(view: View, keys: readonly Key[], gap: number, most = view.rows < TWO_KEY_ROWS_FROM ? 1 : 2): Key[][] {
  const rowsWith = (set: readonly Key[], bare: number) =>
    wrapAt(set.map((key, index) => (index < set.length - bare ? key : bareKey(key))), view.width, gap, keyCells);
  const full = rowsWith(keys, 0);
  if (full.length <= most) return full;
  const short = keys.map(shortKey);
  let bare = 0;
  while (bare < short.length && rowsWith(short, bare).length > most) bare += 1;
  return rowsWith(short, bare);
}

function keyRow(view: View, keys: readonly Key[], gap: number, tail?: RenderElement): RenderElement {
  return view.kit.Box({
    flexDirection: "row",
    columnGap: gap,
    children: [...keys.map(([hotkey, label, work, isOff]) => keyButton(view, hotkey, label, work, isOff)), ...(tail === undefined ? [] : [tail])],
  });
}

const keyRowsOf = (view: View, layout: readonly (readonly Key[])[], gap: number, tail?: RenderElement): RenderElement[] =>
  layout.map((row, index) => keyRow(view, row, gap, index === layout.length - 1 ? tail : undefined));

const keyRows = (view: View, keys: readonly Key[], gap: number): RenderElement[] => keyRowsOf(view, keyLayout(view, keys, gap), gap);

type Frame = { isFull: boolean; keys: Key[][]; chrome: number };

function frameFor(view: View, keys: readonly Key[]): Frame {
  const layout = keyLayout(view, keys, KEY_GAP);
  const isFull = !view.isInline && view.rows - (FULL_CHROME_ROWS + layout.length) >= MIN_LIST_ROWS;
  return { isFull, keys: layout, chrome: (isFull ? FULL_CHROME_ROWS : COMPACT_CHROME_ROWS) + layout.length };
}

function frame(
  view: View,
  { isFull, keys }: Frame,
  parts: { title: string; meta: string; shortMeta: string; above: string; below: string; rows: RenderElement[]; hint: string },
): RenderElement[] {
  const { Box, Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  if (!isFull) {
    const meta = ` ${view.g.dot} ${parts.shortMeta}`;
    const title = fitEnd(parts.title, Math.max(1, view.width - displayWidth(meta)), ellipsis);
    const keysWidth = (keys[0] ?? []).reduce((sum, key) => sum + keyCells(key) + KEY_GAP, 0);
    const hint = fitEnd(parts.hint, view.width - keysWidth, ellipsis);
    return [
      Box({
        flexDirection: "row",
        children: [
          Text({ bold: true, children: [title] }),
          Text({ dimColor: true, children: [fitEnd(meta, view.width - displayWidth(title), ellipsis)] }),
        ],
      }),
      edge(view, parts.above),
      ...parts.rows,
      edge(view, parts.below),
      ...keyRowsOf(view, keys, KEY_GAP, keys.length === 1 ? Text({ dimColor: true, children: [hint === "" ? " " : hint] }) : undefined),
    ];
  }
  return [
    Text({ bold: true, children: [fitEnd(parts.title, view.width, ellipsis)] }),
    Text({ dimColor: true, children: [parts.meta] }),
    rule(view),
    edge(view, parts.above),
    ...parts.rows,
    edge(view, parts.below),
    rule(view),
    ...keyRowsOf(view, keys, KEY_GAP),
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

const moveHint = (view: View) =>
  keyHint([[`${view.g.up}${view.g.down}`, "move"], ["enter", "open"], [KEYS.back, "close"]], view.g);

const masked = (view: View, text: string) => redact(text, view.home, view.g.mask).text;

const dotOf = (view: View) => (view.isAscii ? " | " : ` ${view.g.dot} `);

function proofPieces(view: View, ctx: Ctx, isShort: boolean): Piece[] {
  if (facts.ledgerError !== null) return [{ text: view.g.cross, color: TONE_KEYS.fail }, { text: ` evidence ledger unreadable: ${facts.ledgerError}` }];
  const verdicts = ctx.board.cards.map((card) => verdictOf(card)?.proof);
  if (verdicts.every((verdict) => verdict === undefined)) {
    const note = ctx.board.cards.some((card) => card.files.length > 0) ? "no listed file can be read" : "no task lists a file to prove";
    return [{ text: note, color: TONE_KEYS.muted }];
  }
  const { proven, unproven, failed } = proofSummary(verdicts);
  const sep: Piece = { text: isShort ? "  " : dotOf(view), color: TONE_KEYS.muted };
  const part = (level: Level, count: number, word: string): Piece[] => {
    const { glyph, color } = levelMark(level, view.g);
    const muted = count === 0 ? { color: TONE_KEYS.muted } : {};
    return [{ text: glyph, color: count === 0 ? TONE_KEYS.muted : color }, { text: isShort ? ` ${count}` : ` ${count} ${word}`, ...muted }];
  };
  const counts = [proven, unproven, failed];
  const parts = [part("ok", proven, "proven"), part("warn", unproven, "unproven"), part("fail", failed, "failed")];
  // The one-line header keeps only the counts that are not zero.
  const kept = isShort ? parts.filter((_, index) => counts[index] !== 0) : parts;
  return kept.flatMap((pieces, index) => [...(index === 0 ? [] : [sep]), ...pieces]);
}

function agentPieces(view: View, agents: readonly Agent[]): Piece[] {
  return agents
    .filter((agent) => agent.endedAt === null)
    .flatMap((agent, index) => [
      ...(index === 0 ? [] : [{ text: dotOf(view), color: TONE_KEYS.muted }]),
      { text: `${agentGlyph(agent.type, view.g)} ${shortType(agent.type)}`, color: agentKey(agent.type) },
      ...(agent.task === undefined ? [] : [{ text: ` on ${agent.task}`, color: TONE_KEYS.muted }]),
    ]);
}

function tally(ctx: Ctx) {
  const statuses = ctx.board.cards.map((card) => statusOf(ctx, card));
  const count = (status: Status) => statuses.filter((each) => each === status).length;
  return { done: count("done"), active: count("progress"), blocked: count("blocked"), todo: count("open") };
}

function statusChip(view: View, board: Board): Piece[] {
  if (board.status === null) return [];
  return [chip(board.status, board.status === "FINAL" ? "plan" : "warn", view.isAscii), { text: " " }];
}

type Head = "line" | "lines" | "card";

const headOf = (view: View): Head => (view.isInline || view.rows < SHORT_ROWS ? "line" : view.rows < CARD_FROM_ROWS ? "lines" : "card");

function header(view: View, ctx: Ctx, head: Head): RenderElement[] {
  const { board, plan } = ctx;
  const parts = tally(ctx);
  const count = `${parts.done}/${board.cards.length}`;
  const ellipsis = view.g.ellipsis;
  const lead = statusChip(view, board);
  if (head !== "card") {
    const runningCount = ctx.agents.filter((agent) => agent.endedAt === null).length;
    const counts: Piece[] = [{ text: " " }, ...bar(parts, COMPACT_BAR, view.isAscii), { text: ` ${count} `, bold: true }];
    const running: Piece[] = runningCount === 0 ? [] : [{ text: `  ${view.g.agent} `, color: TONE_KEYS.active }, { text: `${runningCount} running` }];
    const tails = [[...counts, ...proofPieces(view, ctx, true), ...running], [...counts, ...running], counts];
    if (head === "lines") {
      return [
        Line(view.kit, fitPieces([...lead, { text: plan.title, bold: true }], view.width, ellipsis)),
        Line(view.kit, fitPieces((tails[0] ?? []).slice(1), view.width, ellipsis)),
      ];
    }
    const wanted = Math.min(displayWidth(plan.title), Math.ceil(view.width * TITLE_SHARE));
    const tail = tails.find((each) => view.width - piecesWidth(lead) - piecesWidth(each) >= wanted) ?? counts;
    const room = Math.max(1, view.width - piecesWidth(lead) - piecesWidth(tail));
    return [Line(view.kit, fitPieces([...lead, { text: fitEnd(plan.title, room, ellipsis), bold: true }, ...tail], view.width, ellipsis))];
  }
  const inner = Math.max(1, view.width - 4);
  const next = board.cards.find((card) => !card.done);
  const running = agentPieces(view, ctx.agents);
  const blocked: Piece[] =
    parts.blocked === 0
      ? []
      : [{ text: dotOf(view), color: TONE_KEYS.muted }, { text: view.g.blocked, color: TONE_KEYS.warn }, { text: ` ${parts.blocked} blocked` }];
  const barWidth = Math.max(4, Math.min(HEADER_BAR, inner - piecesWidth(lead) - displayWidth(` ${count}`) - piecesWidth(blocked)));
  const lines: Piece[][] = [
    [...lead, ...bar(parts, barWidth, view.isAscii), { text: ` ${count}`, bold: true }, ...blocked],
    proofPieces(view, ctx, false),
    next === undefined
      ? [{ text: `${view.g.check} every task is done`, color: TONE_KEYS.ok }]
      : [
          { text: "next ", color: TONE_KEYS.muted },
          { text: `${next.n} `, bold: true, color: TONE_KEYS.active },
          { text: next.title, color: ON_SURFACE },
        ],
    ...(running.length === 0 ? [] : [running]),
  ];
  return [
    CardBox(view.kit, {
      key: "plan-header",
      title: fitEnd(plan.title, inner, ellipsis),
      tone: next === undefined ? "ok" : "plan",
      isAscii: view.isAscii,
      width: view.width,
      children: lines.map((pieces) => Line(view.kit, fitPieces(pieces, inner, ellipsis))),
    }),
  ];
}

const headerRows = (ctx: Ctx, head: Head) => {
  if (head !== "card") return head === "line" ? 1 : 2;
  return CARD_ROWS + (ctx.agents.some((agent) => agent.endedAt === null) ? 1 : 0);
};

function rightPieces(view: View, ctx: Ctx, card: Card, isShort: boolean): Piece[] {
  const pieces: Piece[] = [];
  for (const agent of ctx.running.get(card.n) ?? []) {
    const glyph = agentGlyph(agent.type, view.g);
    pieces.push({ text: " " }, { text: isShort ? glyph : `${glyph} ${shortType(agent.type)}`, color: agentKey(agent.type) });
  }
  const waiting = waitingOn(ctx, card);
  if (!card.done && waiting.length > 0 && !ctx.running.has(card.n)) {
    if (isShort) pieces.push({ text: " " }, { text: view.g.blocked, color: TONE_KEYS.warn }, { text: ` ${waiting.join(",")}` });
    else pieces.push({ text: " " }, { text: `blocked by ${waiting.join(", ")}`, color: TONE_KEYS.muted });
  }
  const verdict = verdictOf(card);
  if (verdict !== undefined) {
    const { word, tone, level } = PROOF[verdict.proof];
    pieces.push({ text: " " }, chip(isShort ? levelMark(level, view.g).glyph : word, tone, view.isAscii));
  }
  return pieces;
}

// The title is the row's Button, and a Button's label takes no color or bold.
function taskRow(
  view: View,
  ctx: Ctx,
  card: Card,
  { width, numWidth, isShort }: { width: number; numWidth: number; isShort: boolean },
  isCurrent: boolean,
  onPress: () => unknown,
): RenderElement {
  const { Box, Button, Text } = view.kit;
  const status = statusOf(ctx, card);
  const isNext = card.n === ctx.board.cards.find((each) => !each.done)?.n;
  const fixed = 2 + numWidth + 1;
  // Chips read as words while the title keeps its room, the whole title in a split list; glyphs otherwise.
  const words = rightPieces(view, ctx, card, false);
  const titleRoom = width - fixed - piecesWidth(words) - (words.length > 0 ? 1 : 0);
  const right = titleRoom >= (isShort ? displayWidth(card.title) : MIN_TITLE) ? words : rightPieces(view, ctx, card, true);
  const room = Math.max(1, width - fixed - piecesWidth(right));
  const titleText = fitEnd(card.title, room - (right.length > 0 ? 1 : 0), view.g.ellipsis);
  const pad = " ".repeat(Math.max(0, room - displayWidth(titleText)));
  const color = STATUS[status].color;
  const paint = ({ text, ...style }: Piece) => {
    if (style.backgroundColor !== undefined) return Text({ ...style, children: [text] });
    return Text({ ...(isCurrent ? { color: ON_SURFACE, bold: true } : style), hover: { color: ON_SURFACE }, children: [text] });
  };
  return Box({
    key: `line-${TASK}${card.n}`,
    flexDirection: "row",
    width,
    hover: { backgroundColor: TONE_KEYS.focus },
    ...(isCurrent ? { backgroundColor: TONE_KEYS.focus } : {}),
    children: [
      paint({ text: `${glyphOf(view, status)} `, ...(color === undefined ? {} : { color }) }),
      paint({ text: padStart(String(card.n), numWidth), ...(card.done ? { dimColor: true } : isNext ? { color: ON_SURFACE, bold: true } : {}) }),
      paint({ text: " " }),
      Button({
        key: `${TASK}${card.n}`,
        label: titleText,
        plain: true,
        hover: { color: ON_SURFACE },
        ...(card.done ? { dimColor: true } : {}),
        ...(isCurrent ? { autoFocus: true } : {}),
        onPress: view.press(onPress),
      }),
      Text({ wrap: "truncate-end", children: [paint({ text: pad }), ...right.map(paint)] }),
    ],
  });
}

function groupRow(view: View, ctx: Ctx, item: Extract<Item, { kind: "group" }>, width: number, isSpotlit: boolean): RenderElement {
  const title = ctx.board.groups[item.group]?.title ?? "";
  const pieces = rulePieces(width, view.g, view.isAscii, title, { done: item.done, total: item.total });
  // The spotlight: only the cursor's milestone keeps a bright label.
  const lit = isSpotlit ? pieces : pieces.map((piece) => (piece.bold === true ? { text: piece.text, color: TONE_KEYS.muted } : piece));
  return view.kit.Box({ key: `group-${item.group}`, children: [Line(view.kit, lit)] });
}

const checkSentence = (view: View, card: Card) =>
  `Run ${card.checks.map((check) => `\`${masked(view, check)}\``).join(" and ")} to check task ${card.n}, then record the result with evidence_log.`;

async function runCheck(host: Host, view: View, card: Card | undefined): Promise<void> {
  if (card === undefined) return;
  if (card.checks.length === 0) {
    note = { text: `Task ${card.n} names no check command.`, level: "warn" };
    host.ui.invalidate();
    return;
  }
  await host.prompt.fill({ text: checkSentence(view, card) });
}

async function startHere(host: Host, view: View, plan: Loaded, card: Card | undefined): Promise<void> {
  if (card === undefined) return;
  await host.prompt.fill({ text: `/oh-my-claudeagent:start-work ${masked(view, plan.path)} from task ${card.n}` });
}

async function copyTask(host: Host, view: View, plan: Loaded, card: Card | undefined): Promise<void> {
  if (card === undefined) return;
  const body = plan.pages[card.page]?.body ?? "";
  const { text, masked: count } = redact(taskMarkdown(card, body), view.home, view.g.mask);
  const result = await host.ui.copy({ text });
  const hidden = count === 0 ? "" : ` with ${count} secret${count === 1 ? "" : "s"} masked`;
  note = result.isCopied
    ? { text: `Copied task ${card.n}${hidden}.`, level: "ok" }
    : { text: `Could not copy task ${card.n}: ${result.reason}.`, level: "fail" };
  host.ui.invalidate();
}

async function toEvidence(host: Host): Promise<void> {
  await patchPane(host, (pane) => ({ ...pane, tab: "evidence" }));
  host.ui.invalidate();
}

function toggle(host: Host, change: Partial<Filter>): void {
  filter = { ...filter, ...change };
  note = undefined;
  host.ui.invalidate();
  refocus(host, `${TASK}${task}`);
}

// The ring leaves the rows for the field, so a narrowed list must not pull it back to a row.
function editFilter(host: Host): void {
  filter = { ...filter, isEditing: true };
  isRingOnRow = false;
  host.ui.invalidate();
  refocus(host, FILTER);
}

function openDetail(host: Host, n: number): void {
  task = n;
  mode = "detail";
  note = undefined;
  host.ui.invalidate();
}

function selectTask(host: Host, n: number): void {
  task = n;
  note = undefined;
  host.ui.invalidate();
  refocus(host, `${TASK}${n}`);
}

function actionKeys(host: Host, view: View, plan: Loaded, card: Card | undefined): Key[] {
  return [
    ["k", "Run check", () => runCheck(host, view, card), card === undefined || card.checks.length === 0],
    ["s", "Start here", () => startHere(host, view, plan, card), card === undefined || card.done],
    ["c", "Copy", () => copyTask(host, view, plan, card), card === undefined],
    ["e", "Evidence", () => toEvidence(host)],
  ];
}

function boardKeys(host: Host, view: View, plan: Loaded, card: Card | undefined): Key[] {
  return [
    ...actionKeys(host, view, plan, card),
    ["o", "Open only", () => toggle(host, { isOpenOnly: !filter.isOpenOnly }), !filter.isOpenOnly],
    ["x", "Failing", () => toggle(host, { isFailingOnly: !filter.isFailingOnly }), !filter.isFailingOnly],
    ["f", "Find", () => editFilter(host)],
    [KEYS.contents, "Sections", () => toContents(host)],
    [KEYS.list, "Plans", () => showPlans(host)],
  ];
}

function filterRow(host: Host, view: View, shown: number, total: number): RenderElement {
  const { Box, Text } = view.kit;
  const flags: Piece[] = [
    ...(filter.isOpenOnly ? [{ text: " " }, chip("OPEN", "info", view.isAscii)] : []),
    ...(filter.isFailingOnly ? [{ text: " " }, chip("FAILING", "fail", view.isAscii)] : []),
    { text: ` ${shown} of ${total}`, color: TONE_KEYS.muted },
  ];
  const room = Math.max(8, view.width - piecesWidth(flags));
  const field = filter.isEditing
    ? Field(view.kit, {
        key: FILTER,
        label: "Find",
        placeholder: "number, title or path",
        value: filter.text,
        onInput: (value) => {
          filter = { ...filter, text: value };
          host.ui.invalidate();
        },
        onSubmit: (value) => {
          filter = { ...filter, text: value, isEditing: false };
          isFieldClosing = true;
          host.ui.invalidate();
        },
      })
    : Text({ wrap: "truncate-end", children: [fitEnd(`Find: ${filter.text}`, room, view.g.ellipsis)] });
  return Box({
    key: "filter-row",
    flexDirection: "row",
    width: view.width,
    children: [Box({ flexGrow: 1, children: [field] }), Line(view.kit, flags)],
  });
}

const one = (element: RenderElement): Unit => ({ element, rows: 1 });

// Pieces in rows no wider than `width`, a row breaking before the first piece that does not fit.
function wrapPieces(pieces: readonly Piece[], width: number): Piece[][] {
  const rows: Piece[][] = [[]];
  let used = 0;
  for (const piece of pieces) {
    const cells = displayWidth(piece.text);
    if (used > 0 && used + cells > width && piece.text.trim() !== "") {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)?.push(piece);
    used += cells;
  }
  return rows;
}

function filesLines(view: View, card: Card, verdict: Verdict | undefined, width: number): Unit[] {
  return card.files.flatMap((file) => {
    const at = facts.changes.get(file);
    const isLatest = verdict !== undefined && verdict.proof !== "proven" && at === verdict.changedAt;
    const when: Piece =
      at === undefined
        ? { text: "" }
        : at === null
          ? { text: "not found", color: TONE_KEYS.muted }
          : { text: `changed ${timeAgo(view.now - at)}`, color: isLatest ? TONE_KEYS.warn : TONE_KEYS.muted };
    const path = masked(view, file);
    const gap = width - 2 - displayWidth(path) - displayWidth(when.text);
    if (gap >= 1) return [one(Line(view.kit, [{ text: "  " }, { text: path }, { text: " ".repeat(gap) }, when]))];
    return [
      ...wrapText(path, width - 2).map((part) => one(Line(view.kit, [{ text: `  ${part}` }]))),
      ...(when.text === "" ? [] : [one(Line(view.kit, [{ text: "    " }, when]))]),
    ];
  });
}

function runLines(view: View, run: Run, width: number): Unit[] {
  const { glyph, color } = levelMark(run.exitCode === 0 ? "ok" : "fail", view.g);
  const head = `  ${glyph} ${run.type} `;
  const tail = `exit ${run.exitCode} ${view.g.dot} ${timeAgo(view.now - run.at)}`;
  const tailColor = run.exitCode === 0 ? TONE_KEYS.muted : TONE_KEYS.fail;
  const command = masked(view, run.command);
  if (displayWidth(head) + displayWidth(command) + 1 + displayWidth(tail) <= width) {
    return [one(Line(view.kit, [{ text: `  ${glyph} `, color }, { text: `${run.type} `, bold: true }, { text: command }, { text: ` ${tail}`, color: tailColor }]))];
  }
  const parts = wrapText(command, Math.max(1, width - displayWidth(head)));
  const hang = " ".repeat(displayWidth(head));
  return [
    ...parts.map((part, index) =>
      one(Line(view.kit, index === 0 ? [{ text: `  ${glyph} `, color }, { text: `${run.type} `, bold: true }, { text: part }] : [{ text: `${hang}${part}` }])),
    ),
    one(Line(view.kit, [{ text: `${hang}${tail}`, color: tailColor }])),
  ];
}

function evidenceLines(view: View, card: Card, verdict: Verdict | undefined, width: number): Unit[] {
  const say = (text: string, color: ThemeKey) => wrapText(text, width - 2).map((part) => one(Line(view.kit, [{ text: `  ${part}`, color }])));
  const marked = (level: Level, text: string) => {
    const { glyph, color } = levelMark(level, view.g);
    return wrapText(text, width - 4).map((part, index) =>
      one(Line(view.kit, index === 0 ? [{ text: "  " }, { text: glyph, color }, { text: ` ${part}` }] : [{ text: `    ${part}` }])),
    );
  };
  if (facts.ledgerError !== null) return marked("fail", `ledger unreadable: ${facts.ledgerError}`);
  if (card.files.length === 0) return say("Lists no files, so no run can prove it.", TONE_KEYS.muted);
  if (verdict === undefined) return say(UNREADABLE, TONE_KEYS.muted);
  if (verdict.since.length > 0) return verdict.since.slice(0, EVIDENCE_SHOWN).flatMap((run) => runLines(view, run, width));
  return [
    ...marked("warn", `No test, build or lint run since its files changed ${timeAgo(view.now - verdict.changedAt)}.`),
    ...(verdict.lastPass === undefined ? [] : [...say("Last pass, before that change:", TONE_KEYS.muted), ...runLines(view, verdict.lastPass, width)]),
  ];
}

function depChips(view: View, ctx: Ctx, card: Card): Piece[] {
  return card.depends.flatMap((n, index) => {
    const dep = ctx.byN.get(n);
    const status = dep === undefined ? "open" : statusOf(ctx, dep);
    return [...(index === 0 ? [] : [{ text: " " }]), chip(`${glyphOf(view, status)} ${n}`, STATUS[status].tone, view.isAscii)];
  });
}

const label = (view: View, text: string) => view.kit.Text({ bold: true, color: ON_SURFACE, children: [text] });

const fieldsText = (card: Card, name: string) =>
  card.fields
    .filter((field) => field.name.toLowerCase() === name)
    .map((field) => field.text)
    .join("\n\n");

const SHOWN_APART = ["file", "files", "depends", "depends on", "done when", "do"];

// What a Done when line says besides its commands, which are drawn on their own.
function proseOf(card: Card, text: string): string {
  const prose = text
    .replace(/`([^`]+)`/g, (span, inner: string) => (card.checks.includes(inner.trim()) ? "" : span))
    .replace(/[ \t]+/g, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(prose) ? prose : "";
}

// A card as units a region can window, every line wrapped to `width`.
function detail(view: View, ctx: Ctx, card: Card, width: number): Unit[] {
  const { Text } = view.kit;
  const status = statusOf(ctx, card);
  const verdict = verdictOf(card);
  const chips: Piece[] = [
    chip(STATUS[status].word, STATUS[status].tone, view.isAscii),
    ...(verdict === undefined ? [] : [{ text: " " }, chip(PROOF[verdict.proof].word, PROOF[verdict.proof].tone, view.isAscii)]),
    ...(ctx.running.get(card.n) ?? []).flatMap((agent) => [{ text: " " }, { text: `${agentGlyph(agent.type, view.g)} ${shortType(agent.type)}`, color: agentKey(agent.type) }]),
  ];
  const other = card.fields.filter((field) => !SHOWN_APART.includes(field.name.toLowerCase()));
  const doText = fieldsText(card, "do");
  const doneWhen = fieldsText(card, "done when");
  const md = (key: string, text: string): Unit[] => markdownUnits(view.kit, masked(view, text), width, key);
  const lines = (pieces: readonly Piece[]): Unit[] => wrapPieces(pieces, width).map((row) => one(Line(view.kit, fitPieces(row, width, view.g.ellipsis))));
  const gap = one(Text({ children: [" "] }));
  const title = `${card.n}. ${card.title}`;
  const hidden = redact([card.fields.map((field) => field.text).join("\n"), ...(verdict?.since ?? []).map((run) => run.command)].join("\n"), view.home, view.g.mask).masked;
  const deps = depChips(view, ctx, card);
  const waiting = card.done ? [] : waitingOn(ctx, card);
  const prose = proseOf(card, doneWhen);
  return [
    { element: Text({ bold: true, wrap: "wrap", children: [title] }), rows: wrapText(title, width).length },
    ...lines(chips),
    ...(doText === "" ? [] : [gap, one(label(view, "Do")), ...md(`do-${card.n}`, doText)]),
    ...other.flatMap((field, index) => md(`field-${card.n}-${index}`, field.name === "" ? field.text : `**${field.name}:** ${field.text}`)),
    ...(doneWhen === ""
      ? []
      : [
          gap,
          one(label(view, "Done when")),
          ...card.checks.flatMap((check) => codeUnits(view.kit, `$ ${masked(view, check)}`, width, "bash")),
          ...(prose === "" ? [] : md(`done-${card.n}`, prose)),
        ]),
    ...(deps.length === 0
      ? []
      : [
          gap,
          one(label(view, "Depends")),
          ...lines([...deps, ...(waiting.length === 0 ? [] : [{ text: ` blocked by ${waiting.join(", ")}`, color: TONE_KEYS.warn }])]),
        ]),
    ...(card.files.length === 0 ? [] : [gap, one(label(view, "Files")), ...filesLines(view, card, verdict, width)]),
    gap,
    one(label(view, "Evidence")),
    ...evidenceLines(view, card, verdict, width),
    ...(hidden === 0 ? [] : [gap, one(Line(view.kit, [{ text: `${view.g.mask} ${hidden} secret${hidden === 1 ? "" : "s"} masked`, color: TONE_KEYS.muted }]))]),
  ];
}

type Fact = { key: string; lead: Piece[]; text: string; color: ThemeKey | undefined };

// A card's facts under its row, one line each; rows left over wrap the facts in order, and fewer rows
// keep the first facts.
function expansion(view: View, card: Card, width: number, most: number): RenderElement[] {
  const indent = "     ";
  const room = Math.max(1, width - indent.length);
  const verdict = verdictOf(card);
  const doText = fieldsText(card, "do").split("\n")[0] ?? "";
  const check = card.checks[0];
  const files = card.files
    .map((file) => {
      const at = facts.changes.get(file);
      return `${masked(view, file)} ${at === null ? "not found" : at === undefined ? "" : ago(view.now - at)}`.trim();
    })
    .join(` ${view.g.dot} `);
  const newest = verdict?.since[0];
  const mark = newest === undefined ? undefined : levelMark(newest.exitCode === 0 ? "ok" : "fail", view.g);
  const evidence: Fact =
    card.files.length === 0
      ? { key: "x-evidence", lead: [], text: "no files to prove", color: TONE_KEYS.muted }
      : verdict === undefined
        ? { key: "x-evidence", lead: [], text: UNREADABLE, color: TONE_KEYS.muted }
        : newest === undefined || mark === undefined
          ? { key: "x-evidence", lead: [{ text: `${view.g.warn} `, color: TONE_KEYS.warn }], text: "no run since its files changed", color: TONE_KEYS.muted }
          : {
              key: "x-evidence",
              lead: [{ text: `${mark.glyph} `, color: mark.color }],
              text: `${newest.type} exit ${newest.exitCode} ${view.g.dot} ${masked(view, newest.command)} ${view.g.dot} ${timeAgo(view.now - newest.at)}`,
              color: undefined,
            };
  const all: Fact[] = [
    { key: "x-do", lead: [], text: doText === "" ? "no Do line" : masked(view, doText), color: TONE_KEYS.muted },
    check === undefined
      ? { key: "x-check", lead: [], text: "no check command", color: TONE_KEYS.muted }
      : { key: "x-check", lead: [{ text: "$ ", color: TONE_KEYS.muted }], text: masked(view, check), color: TONE_KEYS.info },
    { key: "x-files", lead: [], text: files === "" ? "no files listed" : files, color: TONE_KEYS.muted },
    evidence,
  ];
  const shown = all.slice(0, most);
  const wrapped = shown.map((fact) => wrapText(fact.text, Math.max(1, room - piecesWidth(fact.lead))));
  let spare = most - shown.length;
  const takes = wrapped.map((parts) => {
    const take = 1 + Math.min(spare, parts.length - 1);
    spare -= take - 1;
    return take;
  });
  return shown.flatMap((fact, at) => {
    const parts = wrapped[at] ?? [];
    const take = takes[at] ?? 1;
    const hang = " ".repeat(piecesWidth(fact.lead));
    return parts.slice(0, take).map((part, index) => {
      const isClipped = index === take - 1 && take < parts.length;
      const text = isClipped ? fitEnd(`${part} ${parts[take] ?? ""}`, Math.max(1, room - piecesWidth(fact.lead)), view.g.ellipsis) : part;
      const pieces: Piece[] = [...(index === 0 ? fact.lead : [{ text: hang }]), { text, ...(fact.color === undefined ? {} : { color: fact.color }) }];
      return view.kit.Box({ key: index === 0 ? fact.key : `${fact.key}-${index}`, children: [Line(view.kit, [{ text: indent }, ...fitPieces(pieces, room, view.g.ellipsis)])] });
    });
  });
}

function contextOf(plan: Loaded, agents: State["agents"] | undefined): Ctx {
  const board = boardFor(plan);
  const list = Object.values(agents ?? {});
  return { plan, board, byN: new Map(board.cards.map((card) => [card.n, card])), running: runningOf(list), agents: list };
}

// The list column takes what its widest row asks for, between a floor and a share of the body.
function splitWidth(view: View, ctx: Ctx, numWidth: number): number {
  const fixed = 2 + numWidth + 1;
  // A row asks for a space before its chips and stops a cell short of the rule.
  const need = Math.max(0, ...ctx.board.cards.map((card) => fixed + displayWidth(card.title) + piecesWidth(rightPieces(view, ctx, card, false)) + 2));
  const most = Math.max(SPLIT_MIN_LIST, Math.min(Math.floor(view.width * SPLIT_SHARE), view.width - 2 - SPLIT_MIN_DETAIL));
  return Math.min(most, Math.max(SPLIT_MIN_LIST, need));
}

function boardView(host: Host, view: View, ctx: Ctx): RenderElement[] {
  const { Box, Text } = view.kit;
  const { board, plan } = ctx;
  const ellipsis = view.g.ellipsis;
  const head = headOf(view);
  const showFilter = filter.isEditing || isFiltered();
  const hintRows = view.isInline || (head === "line" && note === undefined) ? 0 : 1;
  const top = headerRows(ctx, head) + (showFilter ? 1 : 0);
  isLean = isFiltered() && view.rows - (top + 2 + 1 + hintRows) <= LEAN_ROWS;
  const items = itemsOf(board);
  const list = boardList(items);
  const card = items.length === 0 ? undefined : ctx.byN.get(task);
  const keySet = boardKeys(host, view, plan, card);
  let layout = keyLayout(view, keySet, BOARD_KEY_GAP);
  const chrome = top + 2 + layout.length + hintRows;
  const base = Math.max(1, view.rows - chrome);
  const numWidth = Math.max(1, ...board.cards.map((each) => String(each.n).length));
  const isSplit = view.tier === "split" && view.rows >= SPLIT_FROM_ROWS && card !== undefined;
  const listWidth = isSplit ? splitWidth(view, ctx, numWidth) : view.width;
  const rowWidth = isSplit ? listWidth - 1 : listWidth;
  const canExpand = !isSplit && view.tier !== "page" && card !== undefined && base - EXPANSION_MIN >= MIN_LIST_ROWS;
  const under = canExpand ? expansion(view, card, rowWidth, Math.max(EXPANSION_MIN, base - 1 - 2 * NEIGHBOURS)) : [];
  let size = roomFor(view, chrome) - under.length;
  // A list with rows to spare gives them to the keys, so fewer keys draw bare.
  const fuller = keyLayout(view, keySet, BOARD_KEY_GAP, 2);
  if (fuller.length > layout.length && items.length + fuller.length - layout.length <= size) {
    size -= fuller.length - layout.length;
    layout = fuller;
  }
  const keys = keyRowsOf(view, layout, BOARD_KEY_GAP);
  const start = items.length === 0 ? 0 : place(host, "board", list, size, (index) => `${TASK}${taskAt(items, index)?.n ?? task}`);
  const end = Math.min(items.length, start + size);
  isCut = start > 0 || end < items.length;
  const rows = items.slice(start, end).flatMap((item) => {
    if (item.kind === "group") return [groupRow(view, ctx, item, rowWidth, item.group === card?.group)];
    const isCurrent = item.card.n === task;
    // Decided as the row is drawn: a click's focus move can reach the cursor before its press does.
    const n = item.card.n;
    const onPress = isSplit && !isCurrent ? () => selectTask(host, n) : () => openDetail(host, n);
    const row = taskRow(view, ctx, item.card, { width: rowWidth, numWidth, isShort: isSplit }, isCurrent, onPress);
    return isCurrent ? [row, ...under] : [row];
  });
  const tasksIn = (from: number, to: number) => items.slice(from, to).filter((item) => item.kind === "task").length;
  const hiddenAbove = tasksIn(0, start);
  const lead = items[start - 1];
  const column = [
    start === 0
      ? edge(view, "", listWidth)
      : lead?.kind === "group" && hiddenAbove === 0
        ? groupRow(view, ctx, lead, rowWidth, lead.group === card?.group)
        : edge(view, `  ${view.g.up} ${hiddenAbove} more`, listWidth),
    ...(items.length === 0 ? [noticeRow(view, { kind: "empty" }, { loading: "", empty: "No task matches the filter." })] : []),
    ...rows,
    edge(view, end < items.length ? `  ${view.g.down} ${tasksIn(end, items.length)} more` : "", listWidth),
  ];
  const height = size + 2;
  const detailWidth = view.width - listWidth - 2;
  if (isSplit && card.n !== detailShown) {
    resetOffset(DETAIL);
    detailShown = card.n;
  }
  const body =
    isSplit && card !== undefined
      ? [
          Box({
            key: "board-split",
            flexDirection: "row",
            width: view.width,
            children: [
              Box({ flexDirection: "column", width: listWidth, children: column }),
              Box({
                flexDirection: "column",
                width: 1,
                children: Array.from({ length: height }, () => Text({ color: TONE_KEYS.rule, children: [view.g.vrule] })),
              }),
              Box({
                key: "board-detail",
                flexDirection: "column",
                width: detailWidth,
                height,
                overflow: "hidden",
                paddingLeft: 1,
                children: [
                  ScrollRegion({
                    kit: view.kit,
                    g: view.g,
                    key: DETAIL,
                    left: listWidth + 2,
                    top,
                    width: detailWidth - 1,
                    height,
                    units: detail(view, ctx, card, detailWidth - 1),
                  }),
                ],
              }),
            ],
          }),
        ]
      : column;
  const hint: Piece =
    note === undefined ? { text: moveHint(view), color: TONE_KEYS.muted } : { text: note.text, color: levelMark(note.level, view.g).color };
  const shownCount = items.filter((item) => item.kind === "task").length;
  if (isFieldClosing && !filter.isEditing) {
    isFieldClosing = false;
    refocus(host, `${TASK}${task}`);
  }
  return [
    ...header(view, ctx, head),
    ...(showFilter ? [filterRow(host, view, shownCount, board.cards.length)] : []),
    ...body,
    ...keys,
    ...(hintRows === 0 ? [] : [Line(view.kit, fitPieces([hint], view.width, ellipsis))]),
  ];
}

type PageParts = {
  id: string;
  title: string;
  counter: string;
  keys: readonly Key[];
  units: readonly Unit[];
  hint: { text: string; color: ThemeKey };
  isNote: boolean;
};

// A page keeps its header and keys in place and scrolls its body in a region; short panes drop the rule and the hint.
function pageOf(view: View, { id, title, counter, keys, units, hint, isNote }: PageParts): RenderElement[] {
  const { Box, Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const keysShown = keyRows(view, keys, BOARD_KEY_GAP);
  const ruleRows = view.rows >= TWO_KEY_ROWS_FROM ? 1 : 0;
  const hintRows = view.rows >= SHORT_ROWS || isNote ? 1 : 0;
  const above = 1 + keysShown.length + ruleRows;
  if (pageShown !== id) {
    resetOffset(PAGE_REGION);
    pageShown = id;
  }
  return [
    Box({
      flexDirection: "row",
      children: [
        Text({ dimColor: true, children: [fitEnd(title, Math.max(1, view.width - counter.length - 1), ellipsis)] }),
        Box({ flexGrow: 1 }),
        Text({ dimColor: true, children: [counter] }),
      ],
    }),
    ...keysShown,
    ...(ruleRows === 0 ? [] : [rule(view)]),
    ScrollRegion({
      kit: view.kit,
      g: view.g,
      key: PAGE_REGION,
      left: 0,
      top: above,
      width: view.width,
      height: Math.max(1, view.rows - above - hintRows),
      units: [...units],
    }),
    ...(hintRows === 0 ? [] : [Text({ color: hint.color, children: [fitEnd(hint.text, view.width, ellipsis)] })]),
  ];
}

function detailView(host: Host, view: View, ctx: Ctx): RenderElement[] {
  const { Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const order = itemsOf(ctx.board).flatMap((item) => (item.kind === "task" ? [item.card] : []));
  const position = order.findIndex((card) => card.n === task);
  const card = ctx.byN.get(task);
  const back: Key = ["b", "Board", () => toBoard(host)];
  if (card === undefined) {
    return [
      Text({ bold: true, children: [fitEnd(ctx.plan.title, view.width, ellipsis)] }),
      noticeRow(view, { kind: "empty" }, { loading: "", empty: "That task is gone after a reload." }),
      keyRow(view, [back], BOARD_KEY_GAP),
    ];
  }
  const step = (delta: number) => () => {
    const next = order[position + delta];
    if (next === undefined) return;
    task = next.n;
    note = undefined;
    host.ui.invalidate();
  };
  return pageOf(view, {
    id: `task-${card.n}`,
    title: ctx.plan.title,
    counter: position < 0 ? "" : `${position + 1} / ${order.length}`,
    keys: [
      back,
      [KEYS.prev, "Prev", step(-1), position <= 0],
      [KEYS.next, "Next", step(1), position < 0 || position === order.length - 1],
      ...actionKeys(host, view, ctx.plan, card),
    ],
    units: detail(view, ctx, card, view.width),
    hint:
      note === undefined
        ? { text: keyHint([[`${view.g.up}${view.g.down}`, "scroll"], [KEYS.back, "close"]], view.g), color: TONE_KEYS.muted }
        : { text: note.text, color: levelMark(note.level, view.g).color },
    isNote: note !== undefined,
  });
}

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
  const hasBoard = boardFor(plan).cards.length > 0;
  const layout = frameFor(view, [
    ...(hasBoard ? [["b", "Board", () => toBoard(host)] as const] : []),
    [KEYS.reload, "Reload", () => reload(host)],
    [KEYS.list, "Plans", () => showPlans(host)],
  ]);
  const size = roomFor(view, layout.chrome);
  const start = place(host, "contents", list, size, (index) => `${ROW}${index}`);
  const end = Math.min(list.total, start + size);
  isCut = start > 0 || end < list.total;
  const numWidth = Math.max(0, ...plan.pages.map((section) => (section.task === undefined ? 0 : String(section.task.n).length)));
  const rows = plan.pages.slice(start, end).map((section, offset) => {
    const index = start + offset;
    const indent = "  ".repeat(Math.max(0, section.level - 2));
    const title = section.task === undefined ? section.title : section.title.replace(/^\d+/, (digits) => padStart(digits, numWidth));
    const label = fitEnd(`${indent}${markOf(section)}${title}`, view.width - 2, ellipsis);
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
        }),
      }),
    );
  });
  const progress = `${plan.done}/${plan.total} tasks done`;
  const lead = `${progress} ${view.g.dot} `;
  const hidden = plan.pages.length - list.total;
  const below = list.total - end;
  return frame(view, layout, {
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
    hint: moveHint(view),
  });
}

async function reload(host: Host): Promise<void> {
  const plan = (await host.state.plan.get()).value;
  if (plan !== undefined) await load(host, plan.path, { keepPlace: true });
  host.ui.invalidate();
}

async function showPlans(host: Host): Promise<void> {
  await listPlans(host);
  host.ui.invalidate();
  refocus(host, `${PICK}${pick}`);
}

function pageView(host: Host, view: View, plan: Loaded): RenderElement[] {
  const { Text } = view.kit;
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
  const nextIndex = order[position + 1];
  const upcoming = nextIndex === undefined ? undefined : plan.pages[nextIndex];
  const heading = `${markOf(section)}${section.title}`;
  const blank = one(Text({ children: [" "] }));
  return pageOf(view, {
    id: `page-${page}`,
    title: plan.title,
    counter: `${position + 1} / ${order.length}`,
    keys: [contents, [KEYS.prev, "Prev", step(-1), position === 0], [KEYS.next, "Next", step(1), position === order.length - 1], [KEYS.reload, "Reload", () => reload(host)]],
    units: [
      { element: Text({ bold: true, wrap: "wrap", children: [heading] }), rows: wrapText(heading, view.width).length },
      blank,
      ...(section.body === ""
        ? [one(Text({ dimColor: true, children: ["No details under this task."] }))]
        : markdownUnits(view.kit, section.body, view.width, `md-${page}`)),
      ...(upcoming === undefined
        ? []
        : [blank, one(Text({ dimColor: true, children: [fitEnd(`next: ${markOf(upcoming)}${upcoming.title}`, view.width, ellipsis)] }))]),
    ],
    hint: { text: keyHint([[`${view.g.up}${view.g.down}`, "scroll"], [KEYS.back, "close"]], view.g), color: TONE_KEYS.muted },
    isNote: false,
  });
}

const BOUND = "bound";

function plansView(host: Host, view: View, pane: State["pane"] | undefined, plan: State["plan"] | undefined): RenderElement[] {
  const { Box, Button, Text } = view.kit;
  const ellipsis = view.g.ellipsis;
  const words = { loading: "Listing the plans", empty: "" };
  const back: Key | undefined = !isLoaded(plan)
    ? undefined
    : boardFor(plan).cards.length > 0
      ? ["b", "Board", () => toBoard(host)]
      : [KEYS.contents, "Contents", () => toContents(host)];
  const keys: Key[] = [...(back === undefined ? [] : [back]), [KEYS.reload, "Reload", () => showPlans(host)]];
  const listing = pane?.plans;
  if (pane === undefined || listing === undefined || listing === null) return [noticeRow(view, { kind: "loading" }, words)];
  const keysShown = keyRows(view, keys, KEY_GAP);
  if (pane.errors.plans !== null) {
    return [noticeRow(view, { kind: "error", reason: pane.errors.plans }, words), ...keysShown];
  }
  const dir = tildePath(view.platform, listing.dir, view.home);
  if (listing.files.length === 0) {
    const lines = [
      ...(plan === undefined ? wrapText("No plan is bound to this session.", view.width) : []),
      "No plans in",
      fitMiddle(dir, view.width, ellipsis),
      ...wrapText("Make one with /oh-my-claudeagent:plan, then bind it to this session with /oh-my-claudeagent:start-work.", view.width),
    ];
    return [
      ...lines.slice(0, Math.max(1, view.rows - keysShown.length)).map((empty) => noticeRow(view, { kind: "empty" }, { ...words, empty })),
      ...keysShown,
    ];
  }
  const list = picksOf(listing.files);
  const layout = frameFor(view, keys);
  const size = roomFor(view, layout.chrome);
  const start = place(host, "plans", list, size, (index) => `${PICK}${index}`);
  const end = Math.min(list.total, start + size);
  isCut = start > 0 || end < list.total;
  const isBound = (file: PlanFile) => boundTo !== undefined && samePath(view.platform, file.path, boundTo);
  const hasBound = listing.files.some(isBound);
  const countWidth = Math.max(0, ...listing.files.map((file) => displayWidth(tallies.get(file.path) ?? "")));
  const widest = Math.max(...listing.files.map((file) => displayWidth(file.name)));
  const shapes = [
    { bound: hasBound, count: countWidth > 0 },
    { bound: false, count: countWidth > 0 },
    { bound: false, count: false },
  ];
  const rightOf = (shape: { bound: boolean; count: boolean }) =>
    (shape.bound ? BOUND.length + 2 : 0) + (shape.count ? countWidth + 2 : 0) + DATE;
  const shape = shapes.find((each) => view.width - 2 - rightOf(each) - 2 >= Math.min(widest, 16)) ?? { bound: false, count: false };
  const rows = listing.files.slice(start, end).map((file, offset) => {
    const index = start + offset;
    const day = dayOf(file.mtimeMs);
    const count = tallies.get(file.path) ?? "";
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
            label: fitEnd(file.name, Math.max(1, view.width - 2 - rightOf(shape) - 2), ellipsis),
            plain: true,
            ...(index === pick ? { autoFocus: true } : {}),
            onPress: view.press(async () => {
              await load(host, file.path);
              const loaded = (await host.state.plan.get()).value;
              if (isLoaded(loaded)) await gather(host, loaded);
              host.ui.invalidate();
              refocus(host, rowKey());
            }),
          }),
          Box({ flexGrow: 1 }),
          ...(shape.bound ? [Text({ color: TONE_KEYS.plan, children: [isBound(file) ? `${BOUND}  ` : " ".repeat(BOUND.length + 2)] })] : []),
          Text({ dimColor: true, children: [`${shape.count ? `${padStart(count, countWidth)}  ` : ""}${day}`] }),
        ],
      }),
    );
  });
  const count = `${listing.files.length} most recent`;
  const lead = `${count} in `;
  return frame(view, layout, {
    title: "Plans",
    meta: `${lead}${fitMiddle(dir, view.width - displayWidth(lead), ellipsis)}`,
    shortMeta: `${listing.files.length} recent`,
    above: start > 0 ? `  ${view.g.up} ${start} more` : "",
    below: end < list.total ? `  ${view.g.down} ${list.total - end} more` : "",
    rows,
    hint: moveHint(view),
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

async function build(host: Host, view: View): Promise<readonly RenderElement[]> {
  const [plan, pane, agents] = await Promise.all([host.state.plan.get(), host.state.pane.get(), host.state.agents.get()]);
  if (mode === "plans") return plansView(host, view, pane.value, plan.value);
  if (plan.value === undefined) {
    return [noticeRow(view, { kind: "loading" }, { loading: "Reading the plan", empty: "" })];
  }
  if (!isLoaded(plan.value)) return errorView(host, view, plan.value);
  if (mode === "page") return pageView(host, view, plan.value);
  if (mode === "contents" || boardFor(plan.value).cards.length === 0) return contentsView(host, view, plan.value);
  const ctx = contextOf(plan.value, agents.value);
  return mode === "detail" ? detailView(host, view, ctx) : boardView(host, view, ctx);
}

export const view: TabView = async (host, view) => {
  isCut = false;
  const body = await build(host, view);
  return isCut ? [...body, ...blanks(view, 1)] : body;
};
