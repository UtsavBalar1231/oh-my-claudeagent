import { isOpen, type NativeTask } from "../src/core/native-tasks.ts";
import { arrange, displayWidth, type Glyphs } from "../src/core/ui-kit.ts";

export const PANEL = "omca.overview";
export const tabs = ["Tasks", "Agents", "Evidence", "Notepad", "Doctor"] as const;
export type Tab = typeof tabs[number];
export type Continuation = { state: "off" | "on" | "paused" | "stopped"; reason: string };
export type Verdict = "missing" | "historical" | "stale" | "verified";

// The host forces fullscreen below this many columns (SESSION_PANEL_SPLIT_MIN_WIDTH), so f does nothing there.
export const SPLIT_MIN_WIDTH = 108;
export const LIST_CAP = 8;

export function commandTab(input = ""): Tab | undefined {
  const name = input.trim().replace(/^\/omca(?:\s+|$)/i, "").toLowerCase();
  return name === "" ? "Tasks" : tabs.find((tab) => tab.toLowerCase() === name);
}

export function taskCounts(tasks: readonly NativeTask[]) {
  return {
    total: tasks.length,
    done: tasks.filter((task) => task.status === "completed").length,
    blocked: tasks.filter((task) => task.blockedReason !== "").length,
    open: tasks.filter(isOpen).length,
  };
}

/** What the Tasks tab says when no task can run next. */
export function noRunnableNote(tasks: readonly NativeTask[]): string {
  const { blocked, open } = taskCounts(tasks);
  if (open > 0) return "No task can run: every open task waits on another open task.";
  if (blocked > 0) return `No task is open and ${blocked} closed as blocked, so this run is not complete.`;
  return "Every task of this run is completed.";
}

export function progress(tasks: readonly NativeTask[]): { done: string; blocked: string } {
  const { done, total, blocked } = taskCounts(tasks);
  return { done: `${done}/${total} done`, blocked: blocked === 0 ? "" : `${blocked} blocked` };
}

export function continuationLine(continuation: Continuation, tasks: readonly NativeTask[]): { text: string; warning: boolean } | undefined {
  switch (continuation.state) {
    case "off": {
      if (taskCounts(tasks).open === 0) return undefined;
      const reason = plain(continuation.reason).replace(/\s+/g, " ").trim().replace(/\.$/, "");
      return reason === "" ? { text: "This session is not continuing these tasks", warning: false } : { text: `${reason}.`, warning: true };
    }
    case "on":
      return { text: "Continues while tasks stay open", warning: false };
    case "paused":
      return { text: "Paused: your last message asked to pause. Send a message to resume.", warning: true };
    case "stopped": {
      const reason = plain(continuation.reason).replace(/\s+/g, " ").trim().replace(/\.$/, "");
      return { text: `${reason === "" ? "Stopped" : `Stopped: ${reason}`}. Send a message to resume.`, warning: true };
    }
  }
}

export function footerStatus(tasks: readonly NativeTask[], continuation: Continuation, g: Glyphs): { count: string; blocked: string; hold: string } {
  const { done, blocked, total } = taskCounts(tasks);
  return {
    count: `OMCA ${done}/${total}`,
    blocked: blocked === 0 ? "" : ` ${g.blocked} ${blocked}`,
    hold: continuation.state === "paused" || continuation.state === "stopped" ? ` ${continuation.state}` : "",
  };
}

export function verdictText(verdict: Verdict): string {
  switch (verdict) {
    case "missing":
      return "no final verification";
    case "historical":
      return "matching run history";
    case "stale":
      return "earlier run history";
    case "verified":
      return "verified";
  }
}

/** RPC failures arrive as plain `{ type, message }` objects rather than Errors. */
export function errorText(error: unknown): string {
  if (typeof error === "string" && error !== "") return plain(error);
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && error.message !== "") return plain(error.message);
  return "Snapshot unavailable.";
}

export const canToggleFullscreen = (presentation: "panel" | "fullscreen", width: number): boolean => presentation === "panel" || width >= SPLIT_MIN_WIDTH;

export type Hint = { key: string; label: string };

export function fitHints(hints: readonly Hint[], room: number): Hint[] {
  const ranked = hints.map((hint, priority) => ({ hint, priority, min: displayWidth(`${hint.key} ${hint.label}`) }));
  const kept = arrange(ranked, room, 2).filter((item) => item.min <= room);
  return kept.map((item) => item.hint);
}

export function fitParts(parts: readonly string[], room: number): string {
  const ranked = parts.filter(Boolean).map((text, priority) => ({ text, priority, min: displayWidth(text) }));
  const kept = arrange(ranked, room, 3).filter((item) => item.min <= room);
  return kept.map((item) => item.text).join(" · ");
}

export function chipLabels(active: Tab, room: number): Array<{ tab: Tab; label: string }> {
  const full = tabs.map((tab, index) => ({ tab, label: `${index + 1} ${tab}` }));
  if (displayWidth(full.map((chip) => chip.label).join("  ")) <= room) return full;
  return full.map((chip, index) => (chip.tab === active ? chip : { tab: chip.tab, label: String(index + 1) }));
}

export function capList<T>(items: readonly T[], cap = LIST_CAP): { shown: readonly T[]; more: number } {
  return items.length <= cap ? { shown: items, more: 0 } : { shown: items.slice(0, cap - 1), more: items.length - cap + 1 };
}

export const clampCursor = (index: number, length: number): number => Math.max(0, Math.min(index, length - 1));

export function agentLabel(agent: string | undefined): string {
  const name = agent?.replace(/^omca-/, "") ?? "";
  if (name === "") return "Session";
  if (name === "omca") return "OMCA";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

type Member = { id: string; parentID?: string | undefined };

/**
 * A family's sessions with working ones first, each with its own cost. The host's cost of a root is
 * the whole family's, so the root's own share is that total less its descendants'.
 */
export function agentRows<T extends Member>(members: readonly T[], running: (id: string) => boolean, cost: (id: string) => number): { rows: Array<{ session: T; running: boolean; cost: number }>; total: number } {
  const root = members.find((member) => !member.parentID);
  const children = members.filter((member) => !!member.parentID).reduce((sum, member) => sum + cost(member.id), 0);
  const total = root ? cost(root.id) : children;
  const rows = members.map((session) => ({ session, running: running(session.id), cost: session === root ? Math.max(0, total - children) : cost(session.id) }));
  return { rows: rows.toSorted((a, b) => Number(b.running) - Number(a.running)), total };
}

export const money = (value: number): string => `$${value.toFixed(value >= 1 ? 2 : 4)}`;

export function plain(value: string): string {
  // eslint-disable-next-line no-control-regex -- Remote text must not emit terminal controls.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export interface Target {
  sessionID: string;
  location: { directory: string; workspaceID?: string };
}

export function targetKey(target: Target): string {
  return JSON.stringify([target.sessionID, target.location.directory, target.location.workspaceID ?? null]);
}

export interface ReadState<T> {
  key: string;
  phase: "loading" | "ready" | "error";
  /** A refresh the user asked for is waiting or in flight. */
  updating: boolean;
  value: T | undefined;
  error: string | undefined;
}

export function snapshotReader<T>(fetch: (target: Target, signal: AbortSignal) => Promise<T>, publish: (state: ReadState<T> | undefined) => void) {
  let selected: Target | undefined;
  let active: AbortController | undefined;
  let queued = false;
  let manual = false;
  let disposed = false;
  let state: ReadState<T> | undefined;

  function emit(next: ReadState<T> | undefined) {
    state = next;
    publish(next);
  }

  async function drain() {
    if (active || disposed || !selected) return;
    const request = new AbortController();
    active = request;
    queued = false;
    manual = false;
    const target = selected;
    try {
      const value = await fetch(target, request.signal);
      if (active === request) {
        emit({ key: targetKey(target), phase: "ready", updating: manual, value, error: undefined });
      }
    } catch (error) {
      if (active === request) {
        emit({ key: targetKey(target), phase: "error", updating: manual, value: state?.value, error: errorText(error) });
      }
    } finally {
      if (active === request) {
        active = undefined;
        if (queued && !disposed) void drain();
      }
    }
  }

  return {
    select(target: Target | undefined) {
      if (disposed || (target && selected && targetKey(target) === targetKey(selected))) return;
      const previous = active;
      active = undefined;
      manual = false;
      selected = target && {
        sessionID: target.sessionID,
        location: {
          directory: target.location.directory,
          ...(target.location.workspaceID === undefined ? {} : { workspaceID: target.location.workspaceID }),
        },
      };
      queued = !!target;
      emit(target ? { key: targetKey(target), phase: "loading", updating: false, value: undefined, error: undefined } : undefined);
      previous?.abort();
      void drain();
    },
    refresh(byUser = false) {
      if (disposed || !selected) return;
      queued = true;
      if (byUser) {
        manual = true;
        if (state) emit({ ...state, updating: true });
      }
      void drain();
    },
    dispose() {
      disposed = true;
      selected = undefined;
      queued = false;
      manual = false;
      const previous = active;
      active = undefined;
      previous?.abort();
    },
  };
}
