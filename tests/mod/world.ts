import type { AgentInfo, On, RenderElement, RenderSurface, StateRead, TurnUsage, UiPane, UiSelection } from "claude-code";
import { mock, type MockClock } from "claude-code/testing";
import { joinPath, normalizePath, type Platform } from "../../src/core/path.ts";
import { displayWidth, formatWhen } from "../../src/core/ui-kit.ts";

export const PLUGIN = "oh-my-claudeagent";
export const ROOT = "/work";
const HOME = "/home/u";
export const SESSION = "s1";
export const LEDGER = `${ROOT}/.omca/evidence/verification-evidence.json`;
export const BOULDER = `${ROOT}/.omca/state/boulder.json`;
const OUTPUT_STYLE = "---\nname: OMCA Default\nkeep-coding-instructions: true\nforce-for-plugin: true\n---\n\n# oh-my-claudeagent\n";

// Where the session runs: the platform's path shape and the environment that names its home.
// `root` and `home` are spelled as the engine reports them; the other paths are normalized, the way the mod writes them.
export type Layout = {
  name: string;
  platform: Platform;
  root: string;
  home: string;
  env: Readonly<Record<string, string>>;
  plans: string;
  settings: string;
  boulder: string;
};

function layoutOf(name: string, platform: Platform, root: string, home: string, env: Record<string, string>): Layout {
  return {
    name,
    platform,
    root,
    home,
    env,
    plans: joinPath(platform, home, ".claude", "plans"),
    settings: joinPath(platform, home, ".claude", "settings.json"),
    boulder: joinPath(platform, root, ".omca", "state", "boulder.json"),
  };
}

export const POSIX = layoutOf("posix", "linux", ROOT, HOME, { HOME });
export const WINDOWS = layoutOf("win32", "win32", "C:\\work", "C:\\Users\\u", { USERPROFILE: "C:\\Users\\u" });
export const LAYOUTS: readonly Layout[] = [POSIX, WINDOWS];

export type World = {
  layout: Layout;
  sessionId: string;
  spelled: (path: string) => string;
  files: Map<string, { text: string; mtimeMs: number }>;
  settings: Record<string, unknown>;
  agents: AgentInfo[];
  panes: UiPane[];
  reads: string[];
  holds: Map<string, Promise<void>>;
  focused: string[];
  selection: UiSelection | undefined;
  selectionReads: number;
  surfaces: RenderSurface[];
  invalidations: number;
  opened: unknown[];
  logs: string[];
  said: string[];
  clock: MockClock;
  style: string | undefined;
};

const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));

// The test engine resolves a path that is not absolute on its host against its own directory
// before a handler sees it. On a POSIX host a drive or backslash UNC path arrives as `<cwd>/C:\x`;
// a real Windows engine passes it as written, which is the spelling this restores.
const WINDOWS_SPELLING = /^\/.*?\/(?=[A-Za-z]:[\\/]|\\\\)/;
const DRIVE = /^[A-Za-z]:(?=[\\/])/;

/**
 * A Windows host resolves a POSIX-absolute path such as `/work/x` to `D:\work\x` and writes the
 * separators of a drive path as backslashes, where the mod wrote `/work/x` and `C:/work/x`. This
 * restores the mod's spelling so a handler sees the same string on every host.
 */
export function hostSpelling(path: string, platform: Platform): string {
  if (!DRIVE.test(path)) return path;
  return (platform === "win32" ? path : path.replace(DRIVE, "")).replace(/\\/g, "/");
}

// The engine's file, session, settings, pane and clock calls answered from memory. A file is
// found under any spelling of its path: separators and `.` or `..` parts are resolved the way
// the platform's file system would.
export function world(
  on: On,
  files: Readonly<Record<string, string>> = {},
  settings: Record<string, unknown> = {},
  env: Readonly<Record<string, string>> = {},
  layout: Layout = POSIX,
): World {
  const spelled = (path: string) => hostSpelling(layout.platform === "win32" ? path.replace(WINDOWS_SPELLING, "") : path, layout.platform);
  const key = (path: string) => normalizePath(layout.platform, spelled(path));
  const w: World = {
    layout,
    sessionId: SESSION,
    spelled,
    files: new Map(Object.entries(files).map(([path, text], index) => [key(path), { text, mtimeMs: 1_000 + index }])),
    settings,
    agents: [],
    panes: [],
    reads: [],
    holds: new Map(),
    focused: [],
    selection: undefined,
    selectionReads: 0,
    surfaces: ["terminal"],
    invalidations: 0,
    opened: [],
    logs: [],
    said: [],
    clock: mock.clock(on, { now: Date.UTC(2026, 9, 2, 12, 0, 0) }),
    style: OUTPUT_STYLE,
  };
  mock.env(on, { OMCA_GLYPHS: "unicode", ...layout.env, ...env });
  on("session.root", () => ({ value: layout.root }));
  on("session.id", () => ({ value: w.sessionId }));
  on("settings.read", () => ({ value: w.settings }));
  on("agent.list", () => ({ value: w.agents }));
  on("fs.read", { path: /[\\/]output-styles[\\/]omca-default\.md$/ }, (_$, e) => {
    w.reads.push(spelled(e.path));
    return w.style === undefined ? { deny: `ENOENT: no such file, ${spelled(e.path)}` } : { value: w.style };
  });
  on("fs.read", async (_$, e) => {
    w.reads.push(spelled(e.path));
    await w.holds.get(key(e.path));
    const file = w.files.get(key(e.path));
    return file === undefined ? { deny: `ENOENT: no such file, ${spelled(e.path)}` } : { value: file.text };
  });
  on("fs.exists", (_$, e) => {
    w.reads.push(spelled(e.path));
    return { value: w.files.has(key(e.path)) || [...w.files.keys()].some((path) => path.startsWith(`${key(e.path)}/`)) };
  });
  on("fs.stat", (_$, e) => {
    w.reads.push(spelled(e.path));
    const file = w.files.get(key(e.path));
    if (file === undefined) return { deny: `ENOENT: no such file, ${spelled(e.path)}` };
    return { value: { kind: "file", size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } };
  });
  on("fs.list", (_$, e) => {
    w.reads.push(spelled(e.path));
    const dir = key(e.path);
    const files = [...w.files.entries()]
      .filter(([path]) => parent(path) === dir)
      .map(([path, file]) => ({
        name: path.slice(dir.length + 1),
        kind: "file" as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      }));
    const dirs = new Set(
      [...w.files.keys()]
        .filter((path) => path.startsWith(`${dir}/`) && parent(path) !== dir)
        .map((path) => path.slice(dir.length + 1).split("/")[0] ?? ""),
    );
    const entries = [...files, ...[...dirs].map((name) => ({ name, kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false }))];
    return entries.length === 0 ? { deny: `ENOENT: no such directory, ${spelled(e.path)}` } : { value: entries };
  });
  on("ui.open", (_$, e) => (w.opened.push(e), { value: { isPlaced: true } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.log", (_$, e) => (w.logs.push(e.text), e.to === "debug" || w.said.push(e.text), { value: undefined }));
  on("ui.panes", () => ({ value: w.panes }));
  on("ui.focus", (_$, e) => (w.focused.push(e.element ?? ""), {}));
  on("session.surfaces", () => ({ value: w.surfaces }));
  on("ui.invalidate", (_$, e, next) => {
    w.invalidations += 1;
    return next(e);
  });
  on("ui.selection", () => ((w.selectionReads += 1), { value: w.selection }));
  return w;
}

/** Holds every `fs.read` of the file until the returned function runs. */
export function hold(w: World, path: string): () => void {
  let release = () => {};
  w.holds.set(normalizePath(w.layout.platform, w.spelled(path)), new Promise<void>((resolve) => (release = resolve)));
  return release;
}

/**
 * Answers `$.state` from memory, with the one thing the real host does that a plugin cannot:
 * `reset` empties an atom, as /clear, /resume and /branch do. A write redraws nothing here, so
 * a test calls `redraw` on what it mounted.
 */
export function resettableState(on: On): { reset: (key: string) => void } {
  const atoms = new Map<string, StateRead>();
  const at = (e: { plugin: string; key: string }) => `${e.plugin}:${e.key}`;
  on("state.get", (_$, e) => ({ value: atoms.get(at(e)) ?? { value: undefined, version: 0 } }));
  on("state.set", (_$, e) => {
    const version = atoms.get(at(e))?.version ?? 0;
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } };
    atoms.set(at(e), { value: e.value, version: version + 1 });
    return { value: { isSet: true, version: version + 1 } };
  });
  return { reset: (key) => void atoms.delete(`${PLUGIN}:${key}`) };
}

export function write(w: World, path: string, text: string): void {
  const key = normalizePath(w.layout.platform, w.spelled(path));
  w.files.set(key, { text, mtimeMs: (w.files.get(key)?.mtimeMs ?? 1_000) + 1 });
}

export const run = (args: string, columns = 120) =>
  ({
    command: "omca",
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns },
  }) as const;

export type Size = { columns: number; rows: number; placement: "dock" | "inline" };

// The body a terminal of `columns` gives the pane: inline spans the width inside two borders,
// a dock opens at the pane's requested share of the terminal, inside its frame.
export function bodyColumns(size: Size): number {
  if (size.placement === "inline") return size.columns - 4;
  return Math.min(96, Math.max(56, Math.round(size.columns * 0.45))) - 2;
}

export const SIZES: readonly Size[] = [
  { columns: 80, rows: 40, placement: "inline" },
  { columns: 120, rows: 40, placement: "inline" },
  { columns: 200, rows: 50, placement: "inline" },
  { columns: 80, rows: 40, placement: "dock" },
  { columns: 120, rows: 40, placement: "dock" },
  { columns: 200, rows: 50, placement: "dock" },
];

export function pane<S extends RenderSurface>(surface: S, size: Size = { columns: 160, rows: 40, placement: "dock" }) {
  return {
    plugin: PLUGIN,
    surface,
    component: "Pane",
    requestId: "omca",
    viewport: { columns: size.columns, rows: size.rows },
    props: {
      title: "OMCA",
      isFocused: true,
      bodyColumns: bodyColumns(size),
      placement: size.placement,
      scroll: { offset: 0, bodyRows: size.placement === "dock" ? size.rows - 4 : 0 },
      view: {},
    },
  } as const;
}

export type Node = { type: string; props?: Record<string, unknown>; hover?: Record<string, unknown>; children?: unknown };

export const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value;

export const childrenOf = (node: Node): unknown[] =>
  Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children];

/** The first element, the tree itself included, whose `key` prop is `key`. */
export function nodeByKey(element: unknown, key: string): Node | undefined {
  if (!isNode(element)) return undefined;
  if (element.props?.["key"] === key) return element;
  return childrenOf(element).reduce<Node | undefined>((found, child) => found ?? nodeByKey(child, key), undefined);
}

/** An element's text as its row reads: a Button `hotkey: label`, a Box's children joined by its column gap. */
export function textOf(element: unknown): string {
  if (typeof element === "string") return element;
  if (!isNode(element)) return "";
  if (element.type === "Button") return `${String(element.props?.["hotkey"])}: ${String(element.props?.["label"])}`;
  const gap = " ".repeat(typeof element.props?.["columnGap"] === "number" ? element.props["columnGap"] : 0);
  return childrenOf(element).map(textOf).join(gap);
}

// The rows a tree draws, a column Box such as a card spread into the rows it holds.
export function spreadRows(tree: RenderElement): string[] {
  const spread = (element: unknown): string[] =>
    isNode(element) && element.type === "Box" && element.props?.["flexDirection"] === "column" ? childrenOf(element).flatMap(spread) : [textOf(element)];
  return topRows(tree).flatMap(spread);
}

export const isAscii = (row: string): boolean => [...row].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127);

export async function drain(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  for (let next = await stream.next(); next.done !== true; next = await stream.next());
}

export const usage = (input: number, output: number, model = "claude-sonnet-5-5", cacheRead = 0, cacheWrite = 0): TurnUsage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model,
});

/** `10-02 09:05`, a time as the tabs draw it in the local zone. */
export const local = (iso: string): string => formatWhen(iso);

// The cells one element takes across, as the terminal lays it out: Text its string children
// (a wrapping Text its longest word, since it breaks between words),
// a plain Button `key: label`, a row Box its children and gaps, a column Box its widest child.
// Markdown wraps to the box it is given and is left out.
export function cellsAcross(element: unknown): number {
  if (typeof element === "string") return displayWidth(element);
  if (!isNode(element)) return 0;
  const props = element.props ?? {};
  switch (element.type) {
    case "Text": {
      const text = childrenOf(element).filter((child) => typeof child === "string").join("");
      if (props["wrap"] === "wrap") return Math.max(0, ...text.split(" ").map(displayWidth));
      return childrenOf(element).reduce<number>((sum, child) => sum + cellsAcross(child), 0);
    }
    case "Button": {
      const label = String(props["label"] ?? "");
      return displayWidth(typeof props["hotkey"] === "string" ? `${props["hotkey"]}: ${label}` : label);
    }
    case "Box": {
      const children = childrenOf(element);
      if (props["flexDirection"] === "row") {
        const gap = typeof props["columnGap"] === "number" ? props["columnGap"] : 0;
        return children.reduce<number>((sum, child) => sum + cellsAcross(child), 0) + gap * Math.max(0, children.length - 1);
      }
      return Math.max(0, ...children.map(cellsAcross));
    }
    default:
      return 0;
  }
}

export function topRows(tree: RenderElement): unknown[] {
  return isNode(tree) ? childrenOf(tree) : [];
}

/** The text of every row the pane's root column draws, Markdown left out. */
export function rows(tree: RenderElement): string[] {
  const text = (element: unknown): string => {
    if (typeof element === "string") return element;
    if (!isNode(element)) return "";
    const props = element.props ?? {};
    if (element.type === "Button") {
      const label = String(props["label"] ?? "");
      return typeof props["hotkey"] === "string" ? `${props["hotkey"]}: ${label}` : label;
    }
    if (element.type !== "Text" && element.type !== "Box") return "";
    const gap = " ".repeat(typeof props["columnGap"] === "number" ? props["columnGap"] : 0);
    return childrenOf(element).map(text).join(element.type === "Box" ? gap : "");
  };
  return isNode(tree) ? childrenOf(tree).map(text) : [];
}
