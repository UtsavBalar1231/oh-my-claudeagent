import type { RenderElement } from "claude-code";
import { resolveBoundPlan } from "../../src/core/boulder.ts";
import { type Drawn, drawnAt, type FocusList, focusMove, placeWindow, windowOf } from "../../src/core/list-window.ts";
import { BOULDER, LEDGER } from "../../src/core/omca-paths.ts";
import { isAbsolutePath, joinPath, type Platform, samePath, tildePath } from "../../src/core/path.ts";
import {
  type Board,
  boardOf,
  type Card,
  CONTENTS_CAP,
  chunks,
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
import { ago, parseRuns, type Proof, proofOf, proofSummary, type Run, timeAgo, type Verdict } from "../../src/core/proof.ts";
import { displayWidth, fitEnd, fitMiddle, KEYS, keyHint, padStart, shortType } from "../../src/core/ui-kit.ts";
import {
  agentKey,
  bar,
  chip,
  type ChipTone,
  type Level,
  levelMark,
  ON_SURFACE,
  type Piece,
  redact,
  rule as rulePieces,
  type ThemeKey,
  TONE_KEYS,
} from "../../src/core/visual.ts";
import type { Input, Phase } from "../dispatch.ts";
import { type Host, reason, type State } from "../host.ts";
import type { Subcommand } from "../omca-router.ts";
import {
  keyButton,
  noticeRow,
  open,
  PANE,
  patchPane,
  rule,
  sessionOf,
  type TabView,
  type View,
} from "../pane.ts";
import { Card as CardBox, CodeBlock, Field, Line } from "../ui.ts";

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
type Facts = { changes: ReadonlyMap<string, number | null>; runs: readonly Run[]; ledgerError: string | null; signature: string };
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
// Docked: title, meta, rule, two edge lines, rule, key row, hint line.
const DOCK_CHROME_ROWS = 8;
// Inline: the title line, two edge lines, the key row.
const INLINE_CHROME_ROWS = 4;
const DATE = 10;
const KEY_GAP = 3;
const BOARD_KEY_GAP = 2;
// A docked board shorter than this draws its header as two plain lines instead of a card.
const CARD_FROM_ROWS = 24;
// The title and three lines inside the card's two borders; a fourth line when agents run.
const CARD_ROWS = 6;
const EXPANSION_ROWS = 4;
const MIN_TITLE = 12;
const SPLIT_SHARE = 0.55;
const HEADER_BAR = 24;
const COMPACT_BAR = 10;
const EVIDENCE_SHOWN = 3;
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
let facts: Facts = { changes: new Map(), runs: [], ledgerError: null, signature: "" };
let ledgerSeen = "";
let memo: { key: string; board: Board } | undefined;
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

function refocus(host: Host, key: string): void {
  host.clock.after(0, async () => {
    try {
      host.ui.invalidate();
      const { deny } = await host.ui.focus({ requestId: PANE, key });
      if (deny !== undefined) host.log(`omca plan could not refocus ${key}: ${deny}`);
    } catch (error) {
      host.log(`omca plan could not refocus ${key}: ${reason(error)}`);
    }
  });
}

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

const resolved = (platform: Platform, root: string, path: string) => (isAbsolutePath(platform, path) ? path : joinPath(platform, root, path));

// Every listed file's modification time and the whole ledger, read outside any drawing. A file
// that cannot be stated is recorded as null and proves nothing either way.
async function gather(host: Host, plan: Loaded): Promise<void> {
  const [root, { platform }] = await Promise.all([host.session.root(), sessionOf(host)]);
  const paths = [...new Set(boardFor(plan).cards.flatMap((card) => card.files))];
  const stamps = await Promise.all(
    paths.map((path) =>
      host.fs.stat(resolved(platform, root, path)).then(
        (stat) => (stat.kind === "file" ? stat.mtimeMs : null),
        () => null,
      ),
    ),
  );
  const ledgerPath = `${root}/${LEDGER}`;
  const seen = await host.fs.stat(ledgerPath).then(
    ({ mtimeMs }) => String(mtimeMs),
    () => "absent",
  );
  let { runs, ledgerError } = facts;
  if (seen !== ledgerSeen) {
    runs = [];
    ledgerError = null;
    if (seen !== "absent") {
      try {
        runs = parseRuns(await host.fs.read(ledgerPath));
      } catch (error) {
        ledgerError = reason(error);
      }
    }
    ledgerSeen = seen;
  }
  const changes = new Map(paths.map((path, index) => [path, stamps[index] ?? null]));
  const signature = JSON.stringify([[...changes], seen, ledgerError]);
  if (signature === facts.signature) return;
  facts = { changes, runs, ledgerError, signature };
  host.ui.invalidate();
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

async function showBound(host: Host, isTick = false): Promise<void> {
  const bound = await boundPath(host);
  if (bound === undefined) await listPlans(host);
  else await load(host, bound, { isTick });
}

export async function sync(host: Host): Promise<void> {
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
  if (isLoaded(current)) await gather(host, current);
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

function verdictOf(card: Card): Verdict | undefined {
  if (facts.ledgerError !== null) return undefined;
  const changes = card.files.flatMap((file) => {
    const at = facts.changes.get(file);
    return at === undefined || at === null ? [] : [at];
  });
  return proofOf(changes, facts.runs);
}

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
    return [{ kind: "group" as const, group: index, done, total: group.tasks.length }, ...shown.map((card) => ({ kind: "task" as const, card }))];
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
export async function scroll(host: Host, e: Input<"ui.scroll">): Promise<boolean> {
  const list = listShown();
  const last = list === undefined ? undefined : drawn[list];
  const isPage = Math.abs(e.by) === e.bodyRows;
  const isEnd = !isPage && Math.abs(e.by) === e.contentRows;
  if (list === undefined || last === undefined || (!isPage && !isEnd)) return false;
  const ring = await ringOf(host, list);
  if (ring === undefined || ring.focus.rows.length === 0) return false;
  const { rows, total, current } = ring.focus;
  const shown = rows.filter((index) => index >= last.start && index < last.start + last.size).length;
  const at = Math.max(0, rows.indexOf(current));
  const to = isEnd ? (e.by > 0 ? rows.length - 1 : 0) : Math.max(0, Math.min(rows.length - 1, at + Math.sign(e.by) * Math.max(1, shown)));
  const target = rows[to] ?? current;
  if (target === current) return true;
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

// A docked list that has to be cut leaves its tree one row short of the body, so the rows a page key
// asks for (the body's) differ from the rows Home and End ask for (the tree's). An inline tree is
// padded to the body, so there the two stay equal.
function roomFor(view: View, chrome: number, total: number): number {
  const room = Math.max(MIN_LIST_ROWS, view.rows - chrome);
  if (view.isInline) return room;
  return total <= room ? room : Math.max(MIN_LIST_ROWS, room - 1);
}

const listRows = (view: View, total: number) => roomFor(view, view.isInline ? INLINE_CHROME_ROWS : DOCK_CHROME_ROWS, total);

function keyRow(view: View, keys: readonly Key[], gap: number): RenderElement {
  return view.kit.Box({
    flexDirection: "row",
    columnGap: gap,
    children: keys.map(([hotkey, label, work, isOff]) => keyButton(view, hotkey, label, work, isOff)),
  });
}

function keyRows(view: View, keys: readonly Key[], gap: number): RenderElement[] {
  const rows: Key[][] = [];
  let used = Number.POSITIVE_INFINITY;
  for (const key of keys) {
    const needed = displayWidth(`${key[0]}: ${key[1]}`);
    const last = rows.at(-1);
    if (last === undefined || used + gap + needed > view.width) {
      rows.push([key]);
      used = needed;
    } else {
      last.push(key);
      used += gap + needed;
    }
  }
  return rows.map((row) => keyRow(view, row, gap));
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

const moveHint = (view: View) =>
  keyHint([[`${view.g.up}${view.g.down}`, "move"], ["enter", "open"], [KEYS.back, "close"]], view.g);

const piecesWidth = (pieces: readonly Piece[]) => pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);

function fitPieces(pieces: readonly Piece[], width: number, ellipsis: string): Piece[] {
  const out: Piece[] = [];
  let left = width;
  for (const piece of pieces) {
    if (left <= 0) break;
    const text = fitEnd(piece.text, left, ellipsis);
    out.push({ ...piece, text });
    left -= displayWidth(text);
  }
  return out;
}

const masked = (view: View, text: string) => redact(text, view.home, view.g.mask).text;

function proofPieces(view: View, ctx: Ctx, isShort: boolean): Piece[] {
  if (facts.ledgerError !== null) return [{ text: `${view.g.cross} evidence ledger unreadable: ${facts.ledgerError}`, color: TONE_KEYS.fail }];
  const verdicts = ctx.board.cards.map((card) => verdictOf(card)?.proof);
  if (verdicts.every((verdict) => verdict === undefined)) return [{ text: "no task lists a file to prove", color: TONE_KEYS.muted }];
  const { proven, unproven, failed } = proofSummary(verdicts);
  const sep: Piece = { text: isShort ? " " : ` ${view.g.dot} `, color: TONE_KEYS.muted };
  const part = (level: Level, count: number, word: string): Piece => {
    const { glyph, color } = levelMark(level, view.g);
    return { text: isShort ? `${glyph}${count}` : `${glyph} ${count} ${word}`, color: count === 0 ? TONE_KEYS.muted : color };
  };
  return [part("ok", proven, "proven"), sep, part("warn", unproven, "unproven"), sep, part("fail", failed, "failed")];
}

function agentPieces(view: View, agents: readonly Agent[]): Piece[] {
  return agents
    .filter((agent) => agent.endedAt === null)
    .flatMap((agent, index) => [
      ...(index === 0 ? [] : [{ text: ` ${view.g.dot} `, color: TONE_KEYS.muted }]),
      { text: `${view.g.agent} ${shortType(agent.type)}`, color: agentKey(agent.type) },
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

function header(view: View, ctx: Ctx, isCard: boolean): RenderElement[] {
  const { board, plan } = ctx;
  const parts = tally(ctx);
  const count = `${parts.done}/${board.cards.length}`;
  const ellipsis = view.g.ellipsis;
  const lead = statusChip(view, board);
  if (view.isInline || !isCard) {
    const runningCount = ctx.agents.filter((agent) => agent.endedAt === null).length;
    const tail: Piece[] = [
      { text: " " },
      ...bar(parts, COMPACT_BAR, view.isAscii),
      { text: ` ${count} `, bold: true },
      ...proofPieces(view, ctx, true),
      ...(runningCount === 0 ? [] : [{ text: ` ${view.g.agent}${runningCount}`, color: TONE_KEYS.active }]),
    ];
    if (view.isInline) {
      const room = Math.max(1, view.width - piecesWidth(lead) - piecesWidth(tail));
      return [Line(view.kit, fitPieces([...lead, { text: fitEnd(plan.title, room, ellipsis), bold: true }, ...tail], view.width, ellipsis))];
    }
    return [
      Line(view.kit, fitPieces([...lead, { text: plan.title, bold: true }], view.width, ellipsis)),
      Line(view.kit, fitPieces(tail.slice(1), view.width, ellipsis)),
    ];
  }
  const inner = Math.max(1, view.width - 4);
  const next = board.cards.find((card) => !card.done);
  const running = agentPieces(view, ctx.agents);
  const blocked = parts.blocked === 0 ? [] : [{ text: ` ${view.g.dot} ${parts.blocked} blocked`, color: TONE_KEYS.warn }];
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

const headerRows = (view: View, ctx: Ctx, isCard: boolean) => {
  if (view.isInline) return 1;
  if (!isCard) return 2;
  return CARD_ROWS + (ctx.agents.some((agent) => agent.endedAt === null) ? 1 : 0);
};

function rightPieces(view: View, ctx: Ctx, card: Card, isShort: boolean): Piece[] {
  const pieces: Piece[] = [];
  for (const agent of ctx.running.get(card.n) ?? []) {
    pieces.push({ text: " " }, { text: isShort ? view.g.agent : `${view.g.agent} ${shortType(agent.type)}`, color: agentKey(agent.type) });
  }
  const waiting = waitingOn(ctx, card);
  if (!card.done && waiting.length > 0 && !ctx.running.has(card.n)) {
    pieces.push({ text: " " }, { text: isShort ? `${view.g.blocked}${waiting.join(",")}` : `blocked by ${waiting.join(", ")}`, color: TONE_KEYS.warn });
  }
  const verdict = verdictOf(card);
  if (verdict !== undefined) {
    const { word, tone, level } = PROOF[verdict.proof];
    pieces.push({ text: " " }, chip(isShort ? levelMark(level, view.g).glyph : word, tone, view.isAscii));
  }
  return pieces;
}

function taskRow(host: Host, view: View, ctx: Ctx, card: Card, width: number, numWidth: number, isCurrent: boolean): RenderElement {
  const { Box, Button, Text } = view.kit;
  const status = statusOf(ctx, card);
  const isNext = card.n === ctx.board.cards.find((each) => !each.done)?.n;
  const fixed = 2 + numWidth + 1;
  let right = rightPieces(view, ctx, card, false);
  if (width - fixed - piecesWidth(right) < MIN_TITLE) right = rightPieces(view, ctx, card, true);
  const room = Math.max(1, width - fixed - piecesWidth(right));
  const titleText = fitEnd(card.title, room - (right.length > 0 ? 1 : 0), view.g.ellipsis);
  const pad = " ".repeat(Math.max(0, room - displayWidth(titleText)));
  const title: Piece = card.done
    ? { text: titleText, color: TONE_KEYS.muted }
    : isNext
      ? { text: titleText, color: ON_SURFACE, bold: true }
      : { text: titleText };
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
      Button({
        key: `${TASK}${card.n}`,
        label: padStart(String(card.n), numWidth),
        plain: true,
        ...(card.done ? { dimColor: true } : {}),
        ...(isCurrent ? { autoFocus: true } : {}),
        onPress: view.press(() => openDetail(host, card.n)),
      }),
      Text({ wrap: "truncate-end", children: [paint({ text: " " }), paint(title), paint({ text: pad }), ...right.map(paint)] }),
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

function actionKeys(host: Host, view: View, plan: Loaded, card: Card | undefined): Key[] {
  return [
    ["r", "Run check", () => runCheck(host, view, card), card === undefined || card.checks.length === 0],
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

function filesLines(view: View, card: Card, verdict: Verdict | undefined, width: number): RenderElement[] {
  return card.files.map((file) => {
    const at = facts.changes.get(file);
    const isLatest = verdict !== undefined && verdict.proof !== "proven" && at === verdict.changedAt;
    const when: Piece =
      at === undefined
        ? { text: "" }
        : at === null
          ? { text: "not found", color: TONE_KEYS.muted }
          : { text: `changed ${timeAgo(view.now - at)}`, color: isLatest ? TONE_KEYS.warn : TONE_KEYS.muted };
    const path = fitMiddle(masked(view, file), Math.max(4, width - displayWidth(when.text) - 3), view.g.ellipsis);
    const pad = " ".repeat(Math.max(1, width - 2 - displayWidth(path) - displayWidth(when.text)));
    return Line(view.kit, [{ text: "  " }, { text: path }, { text: pad }, when]);
  });
}

function runLine(view: View, run: Run, width: number): RenderElement {
  const { glyph, color } = levelMark(run.exitCode === 0 ? "ok" : "fail", view.g);
  const head = `  ${glyph} ${run.type} `;
  const tail = ` exit ${run.exitCode} ${view.g.dot} ${timeAgo(view.now - run.at)}`;
  const command = fitEnd(masked(view, run.command), Math.max(4, width - displayWidth(head) - displayWidth(tail)), view.g.ellipsis);
  return Line(view.kit, [
    { text: `  ${glyph} `, color },
    { text: `${run.type} `, bold: true },
    { text: command },
    { text: tail, color: run.exitCode === 0 ? TONE_KEYS.muted : TONE_KEYS.fail },
  ]);
}

function evidenceLines(view: View, card: Card, verdict: Verdict | undefined, width: number): RenderElement[] {
  const say = (text: string, color: ThemeKey) => Line(view.kit, [{ text: fitEnd(`  ${text}`, width, view.g.ellipsis), color }]);
  if (facts.ledgerError !== null) return [say(`${view.g.cross} ledger unreadable: ${facts.ledgerError}`, TONE_KEYS.fail)];
  if (card.files.length === 0) return [say("Lists no files, so no run can prove it.", TONE_KEYS.muted)];
  if (verdict === undefined) return [say(UNREADABLE, TONE_KEYS.muted)];
  if (verdict.since.length > 0) return verdict.since.slice(0, EVIDENCE_SHOWN).map((run) => runLine(view, run, width));
  return [
    say(`${view.g.warn} No test, build or lint run since its files changed ${timeAgo(view.now - verdict.changedAt)}.`, TONE_KEYS.warn),
    ...(verdict.lastPass === undefined ? [] : [say("Last pass, before that change:", TONE_KEYS.muted), runLine(view, verdict.lastPass, width)]),
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

function detail(view: View, ctx: Ctx, card: Card, width: number): RenderElement[] {
  const { Markdown, Text } = view.kit;
  const status = statusOf(ctx, card);
  const verdict = verdictOf(card);
  const chips: Piece[] = [
    chip(STATUS[status].word, STATUS[status].tone, view.isAscii),
    ...(verdict === undefined ? [] : [{ text: " " }, chip(PROOF[verdict.proof].word, PROOF[verdict.proof].tone, view.isAscii)]),
    ...(ctx.running.get(card.n) ?? []).flatMap((agent) => [{ text: " " }, { text: `${view.g.agent} ${shortType(agent.type)}`, color: agentKey(agent.type) }]),
  ];
  const other = card.fields.filter((field) => !SHOWN_APART.includes(field.name.toLowerCase()));
  const doText = fieldsText(card, "do");
  const doneWhen = fieldsText(card, "done when");
  const md = (key: string, text: string) => chunks(masked(view, text)).map((part, index) => Markdown({ key: `${key}-${index}`, text: part }));
  const gap = Text({ children: [" "] });
  const hidden = redact([card.fields.map((field) => field.text).join("\n"), ...(verdict?.since ?? []).map((run) => run.command)].join("\n"), view.home, view.g.mask).masked;
  const deps = depChips(view, ctx, card);
  const waiting = card.done ? [] : waitingOn(ctx, card);
  return [
    Text({ bold: true, wrap: "wrap", children: [`${card.n}. ${card.title}`] }),
    Line(view.kit, fitPieces(chips, width, view.g.ellipsis)),
    ...(doText === "" ? [] : [gap, label(view, "Do"), ...md(`do-${card.n}`, doText)]),
    ...other.flatMap((field, index) => md(`field-${card.n}-${index}`, field.name === "" ? field.text : `**${field.name}:** ${field.text}`)),
    ...(doneWhen === ""
      ? []
      : [
          gap,
          label(view, "Done when"),
          ...md(`done-${card.n}`, doneWhen),
          ...card.checks.map((check) => view.kit.Box({ width, children: [CodeBlock(view.kit, { source: masked(view, check), language: "bash" })] })),
        ]),
    ...(deps.length === 0
      ? []
      : [
          gap,
          label(view, "Depends"),
          Line(
            view.kit,
            fitPieces([...deps, ...(waiting.length === 0 ? [] : [{ text: ` blocked by ${waiting.join(", ")}`, color: TONE_KEYS.warn }])], width, view.g.ellipsis),
          ),
        ]),
    ...(card.files.length === 0 ? [] : [gap, label(view, "Files"), ...filesLines(view, card, verdict, width)]),
    gap,
    label(view, "Evidence"),
    ...evidenceLines(view, card, verdict, width),
    ...(hidden === 0 ? [] : [gap, Line(view.kit, [{ text: `${view.g.mask} ${hidden} secret${hidden === 1 ? "" : "s"} masked`, color: TONE_KEYS.muted }])]),
  ];
}

// The focused task's facts in four one-line rows under its row, for widths without a detail column.
function expansion(view: View, card: Card, width: number): RenderElement[] {
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
  const evidence: Piece[] =
    card.files.length === 0
      ? [{ text: "no files to prove", color: TONE_KEYS.muted }]
      : verdict === undefined
        ? [{ text: UNREADABLE, color: TONE_KEYS.muted }]
        : newest === undefined || mark === undefined
          ? [{ text: `${view.g.warn} no run since its files changed`, color: TONE_KEYS.warn }]
          : [
              { text: mark.glyph, color: mark.color },
              { text: ` ${newest.type} exit ${newest.exitCode} ${view.g.dot} ${masked(view, newest.command)} ${view.g.dot} ${timeAgo(view.now - newest.at)}` },
            ];
  const row = (key: string, pieces: Piece[]) =>
    view.kit.Box({ key, children: [Line(view.kit, [{ text: indent }, ...fitPieces(pieces, room, view.g.ellipsis)])] });
  return [
    row("x-do", [{ text: doText === "" ? "no Do line" : masked(view, doText), color: TONE_KEYS.muted }]),
    row("x-check", check === undefined ? [{ text: "no check command", color: TONE_KEYS.muted }] : [{ text: "$ ", color: TONE_KEYS.muted }, { text: masked(view, check), color: TONE_KEYS.info }]),
    row("x-files", [{ text: files === "" ? "no files listed" : files, color: TONE_KEYS.muted }]),
    row("x-evidence", evidence),
  ];
}

function contextOf(plan: Loaded, agents: State["agents"] | undefined): Ctx {
  const board = boardFor(plan);
  const list = Object.values(agents ?? {});
  return { plan, board, byN: new Map(board.cards.map((card) => [card.n, card])), running: runningOf(list), agents: list };
}

function boardView(host: Host, view: View, ctx: Ctx): RenderElement[] {
  const { Box, Text } = view.kit;
  const { board, plan } = ctx;
  const ellipsis = view.g.ellipsis;
  const items = itemsOf(board);
  const list = boardList(items);
  const card = items.length === 0 ? undefined : ctx.byN.get(task);
  const keys = keyRows(view, boardKeys(host, view, plan, card), BOARD_KEY_GAP);
  const isCard = !view.isInline && view.rows >= CARD_FROM_ROWS;
  const showFilter = filter.isEditing || isFiltered();
  const chrome = headerRows(view, ctx, isCard) + (showFilter ? 1 : 0) + 2 + keys.length + (view.isInline ? 0 : 1);
  const room = roomFor(view, chrome, list.total);
  const isSplit = view.tier === "split" && card !== undefined;
  const canExpand = view.tier === "inline" && card !== undefined && room - EXPANSION_ROWS >= MIN_LIST_ROWS;
  const size = canExpand ? room - EXPANSION_ROWS : room;
  const listWidth = isSplit ? Math.floor(view.width * SPLIT_SHARE) : view.width;
  const start = items.length === 0 ? 0 : place(host, "board", list, size, (index) => `${TASK}${taskAt(items, index)?.n ?? task}`);
  const end = Math.min(items.length, start + size);
  const numWidth = Math.max(1, ...board.cards.map((each) => String(each.n).length));
  const rows = items.slice(start, end).flatMap((item) => {
    if (item.kind === "group") return [groupRow(view, ctx, item, listWidth, item.group === card?.group)];
    const isCurrent = item.card.n === task;
    const row = taskRow(host, view, ctx, item.card, listWidth, numWidth, isCurrent);
    return isCurrent && canExpand ? [row, ...expansion(view, item.card, listWidth)] : [row];
  });
  const edge = (text: string) => Text({ dimColor: true, children: [text === "" ? " " : fitEnd(text, listWidth, ellipsis)] });
  const column = [
    edge(start > 0 ? `  ${view.g.up} ${start} more` : ""),
    ...(items.length === 0 ? [noticeRow(view, { kind: "empty" }, { loading: "", empty: "No task matches the filter." })] : []),
    ...rows,
    edge(end < items.length ? `  ${view.g.down} ${items.length - end} more` : ""),
  ];
  const height = size + 2;
  const detailWidth = view.width - listWidth - 2;
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
                children: Array.from({ length: height }, () => Text({ color: TONE_KEYS.rule, children: [view.isAscii ? "|" : "│"] })),
              }),
              Box({
                key: "board-detail",
                flexDirection: "column",
                width: detailWidth,
                height,
                overflow: "hidden",
                paddingLeft: 1,
                children: detail(view, ctx, card, detailWidth - 1),
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
    ...header(view, ctx, isCard),
    ...(showFilter ? [filterRow(host, view, shownCount, board.cards.length)] : []),
    ...body,
    ...keys,
    ...(view.isInline ? [] : [Line(view.kit, fitPieces([hint], view.width, ellipsis))]),
  ];
}

function detailView(host: Host, view: View, ctx: Ctx): RenderElement[] {
  const { Box, Text } = view.kit;
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
  const counter = position < 0 ? "" : `${position + 1} / ${order.length}`;
  const keys: Key[] = [
    back,
    [KEYS.prev, "Prev", step(-1), position <= 0],
    [KEYS.next, "Next", step(1), position < 0 || position === order.length - 1],
    ...actionKeys(host, view, ctx.plan, card),
  ];
  const hint = note === undefined ? keyHint([[`${view.g.up}${view.g.down}`, "scroll"], [KEYS.back, "close"]], view.g) : note.text;
  return [
    Box({
      flexDirection: "row",
      children: [
        Text({ dimColor: true, children: [fitEnd(ctx.plan.title, Math.max(1, view.width - counter.length - 1), ellipsis)] }),
        Box({ flexGrow: 1 }),
        Text({ dimColor: true, children: [counter] }),
      ],
    }),
    ...keyRows(view, keys, BOARD_KEY_GAP),
    rule(view),
    ...detail(view, ctx, card, view.width),
    Text({ children: [" "] }),
    Text({ color: note === undefined ? TONE_KEYS.muted : levelMark(note.level, view.g).color, children: [fitEnd(hint, view.width, ellipsis)] }),
  ];
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
  const size = listRows(view, list.total);
  const start = place(host, "contents", list, size, (index) => `${ROW}${index}`);
  const end = Math.min(list.total, start + size);
  const rows = plan.pages.slice(start, end).map((section, offset) => {
    const index = start + offset;
    const indent = "  ".repeat(Math.max(0, section.level - 2));
    const label = fitEnd(`${indent}${markOf(section)}${section.title}`, view.width - 2, ellipsis);
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
  const hasBoard = boardFor(plan).cards.length > 0;
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
      ...(hasBoard ? [["b", "Board", () => toBoard(host)] as const] : []),
      [KEYS.reload, "Reload", () => reload(host)],
      [KEYS.list, "Plans", () => showPlans(host)],
    ],
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
  const mark = markOf(section);
  const nextIndex = order[position + 1];
  const upcoming = nextIndex === undefined ? undefined : plan.pages[nextIndex];
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
    ...(upcoming === undefined
      ? []
      : [Text({ dimColor: true, children: [fitEnd(`next: ${markOf(upcoming)}${upcoming.title}`, view.width, ellipsis)] })]),
    Text({ dimColor: true, children: [keyHint([[`${view.g.up}${view.g.down}`, "scroll"], [KEYS.back, "close"]], view.g)] }),
  ];
}

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
  const size = listRows(view, list.total);
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
              const loaded = (await host.state.plan.get()).value;
              if (isLoaded(loaded)) await gather(host, loaded);
              host.ui.invalidate();
              refocus(host, rowKey());
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

export const view: TabView = async (host, view) => {
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
};
