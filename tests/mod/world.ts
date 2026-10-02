import type { AgentInfo, On, RenderElement, RenderSurface } from "claude-code";
import { mock, type MockClock } from "claude-code/testing";
import { displayWidth } from "../../src/core/ui-kit.ts";

export const PLUGIN = "oh-my-claudeagent";
export const ROOT = "/work";
export const HOME = "/home/u";
export const SESSION = "s1";
export const PLANS = `${HOME}/.claude/plans`;
export const LEDGER = `${ROOT}/.omca/evidence/verification-evidence.json`;
export const BOULDER = `${ROOT}/.omca/state/boulder.json`;

export type World = {
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

// The engine's file, session, settings, pane and clock calls answered from memory.
export function world(
  on: On,
  files: Readonly<Record<string, string>> = {},
  settings: Record<string, unknown> = {},
  env: Readonly<Record<string, string>> = {},
): World {
  const w: World = {
    files: new Map(Object.entries(files).map(([path, text], index) => [path, { text, mtimeMs: 1_000 + index }])),
    settings,
    agents: [],
    reads: [],
    focused: [],
    opened: [],
    logs: [],
    clock: mock.clock(on, { now: Date.UTC(2026, 9, 2, 12, 0, 0) }),
  };
  mock.env(on, { HOME, ...env });
  on("session.root", () => ({ value: ROOT }));
  on("session.id", () => ({ value: SESSION }));
  on("settings.read", () => ({ value: w.settings }));
  on("agent.list", () => ({ value: w.agents }));
  on("fs.read", (_$, e) => {
    w.reads.push(e.path);
    const file = w.files.get(e.path);
    return file === undefined ? { deny: `ENOENT: no such file, ${e.path}` } : { value: file.text };
  });
  on("fs.exists", (_$, e) => ({
    value: w.files.has(e.path) || [...w.files.keys()].some((path) => path.startsWith(`${e.path}/`)),
  }));
  on("fs.stat", (_$, e) => {
    const file = w.files.get(e.path);
    if (file === undefined) return { deny: `ENOENT: no such file, ${e.path}` };
    return { value: { kind: "file", size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } };
  });
  on("fs.list", (_$, e) => {
    const entries = [...w.files.entries()]
      .filter(([path]) => parent(path) === e.path)
      .map(([path, file]) => ({
        name: path.slice(e.path.length + 1),
        kind: "file" as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      }));
    return entries.length === 0 ? { deny: `ENOENT: no such directory, ${e.path}` } : { value: entries };
  });
  on("ui.open", (_$, e) => (w.opened.push(e), { value: { isPlaced: true } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.log", (_$, e) => (w.logs.push(e.text), { value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("ui.focus", (_$, e) => (w.focused.push(e.element ?? ""), {}));
  return w;
}

export function write(w: World, path: string, text: string): void {
  w.files.set(path, { text, mtimeMs: (w.files.get(path)?.mtimeMs ?? 1_000) + 1 });
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
