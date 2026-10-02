import type { AgentInfo, On, RenderElement, RenderSurface } from "claude-code";
import { mock, type MockClock } from "claude-code/testing";
import { joinPath, normalizePath, type Platform } from "../../src/core/path.ts";
import { displayWidth } from "../../src/core/ui-kit.ts";

export const PLUGIN = "oh-my-claudeagent";
export const ROOT = "/work";
export const HOME = "/home/u";
export const SESSION = "s1";
export const PLANS = `${HOME}/.claude/plans`;
export const LEDGER = `${ROOT}/.omca/evidence/verification-evidence.json`;
export const BOULDER = `${ROOT}/.omca/state/boulder.json`;

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
  spelled: (path: string) => string;
  files: Map<string, { text: string; mtimeMs: number }>;
  settings: Record<string, unknown>;
  agents: AgentInfo[];
  reads: string[];
  focused: string[];
  opened: unknown[];
  logs: string[];
  clock: MockClock;
};

const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));

// The test engine resolves a path that is not POSIX-absolute against its own directory before a
// handler sees it, so a drive or backslash UNC path arrives as `<cwd>/C:\x`. A real Windows
// engine passes it as written, which is the spelling this restores.
const WINDOWS_SPELLING = /^\/.*?\/(?=[A-Za-z]:[\\/]|\\\\)/;

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
  const spelled = (path: string) => (layout.platform === "win32" ? path.replace(WINDOWS_SPELLING, "") : path);
  const key = (path: string) => normalizePath(layout.platform, spelled(path));
  const w: World = {
    layout,
    spelled,
    files: new Map(Object.entries(files).map(([path, text], index) => [key(path), { text, mtimeMs: 1_000 + index }])),
    settings,
    agents: [],
    reads: [],
    focused: [],
    opened: [],
    logs: [],
    clock: mock.clock(on, { now: Date.UTC(2026, 9, 2, 12, 0, 0) }),
  };
  mock.env(on, { ...layout.env, ...env });
  on("session.root", () => ({ value: layout.root }));
  on("session.id", () => ({ value: SESSION }));
  on("settings.read", () => ({ value: w.settings }));
  on("agent.list", () => ({ value: w.agents }));
  on("fs.read", (_$, e) => {
    w.reads.push(spelled(e.path));
    const file = w.files.get(key(e.path));
    return file === undefined ? { deny: `ENOENT: no such file, ${spelled(e.path)}` } : { value: file.text };
  });
  on("fs.exists", (_$, e) => ({
    value: w.files.has(key(e.path)) || [...w.files.keys()].some((path) => path.startsWith(`${key(e.path)}/`)),
  }));
  on("fs.stat", (_$, e) => {
    const file = w.files.get(key(e.path));
    if (file === undefined) return { deny: `ENOENT: no such file, ${spelled(e.path)}` };
    return { value: { kind: "file", size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } };
  });
  on("fs.list", (_$, e) => {
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
  on("ui.log", (_$, e) => (w.logs.push(e.text), { value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("ui.focus", (_$, e) => (w.focused.push(e.element ?? ""), {}));
  return w;
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

type Node = { type: string; props?: Record<string, unknown>; children?: unknown };

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value;

const childrenOf = (node: Node): unknown[] =>
  Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children];

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
