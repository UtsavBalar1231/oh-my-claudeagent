import { describe, expect, test } from "bun:test";
import type { NativeTask } from "../src/core/native-tasks.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import { agentLabel, agentRows, canToggleFullscreen, capList, chipLabels, clampCursor, commandTab, continuationLine, errorText, fitHints, fitParts, footerStatus, noRunnableNote, plain, progress, snapshotReader, targetKey, verdictText, type ReadState, type Target } from "./tui-model.ts";

const target = (sessionID: string, directory = "/checkout"): Target => ({ sessionID, location: { directory } });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const row = (id: string, status: NativeTask["status"], blockedReason = "", blockedBy: string[] = [], isFinal = false): NativeTask => ({ id, subject: `Task ${id}`, description: "", activeForm: "", status, owner: "", blocks: [], blockedBy, run: "work", isFinal, blockedReason, details: [] });
const off = { state: "off", reason: "" } as const;

function harness() {
  const calls: Array<{ target: Target; signal: AbortSignal; resolve: (value: string) => void; reject: (error: unknown) => void }> = [];
  const updates: Array<ReadState<string> | undefined> = [];
  const reader = snapshotReader<string>((selected, signal) => new Promise((resolve, reject) => {
    calls.push({ target: selected, signal, resolve, reject });
  }), (state) => updates.push(state));
  return { reader, calls, updates, latest: () => updates.at(-1) };
}

test("/omca opens Tasks by default and accepts only the panel's tabs, with or without the slash prefix", () => {
  expect(commandTab()).toBe("Tasks");
  expect(commandTab("/omca")).toBe("Tasks");
  expect(commandTab(" /omca  evidence ")).toBe("Evidence");
  expect(commandTab("doctor")).toBe("Doctor");
  expect(commandTab("tasks")).toBe("Tasks");
  expect(commandTab("agents")).toBe("Agents");
  expect(commandTab("notepad")).toBe("Notepad");
  expect(commandTab("overview")).toBeUndefined();
  expect(commandTab("start-work")).toBeUndefined();
  expect(commandTab("plan")).toBeUndefined();
  expect(commandTab("tasks /other/file")).toBeUndefined();
});

describe("the Tasks tab", () => {
  test("a run with an open task and none runnable says so", () => {
    expect(noRunnableNote([row("1", "pending"), row("2", "pending")])).toBe("No task can run: every open task waits on another open task.");
  });

  test("a run with no open task and a blocked one says it is not complete", () => {
    expect(noRunnableNote([row("1", "completed"), row("2", "pending", "no access")])).toBe("No task is open and 1 closed as blocked, so this run is not complete.");
  });

  test("a run with every task completed says that", () => {
    expect(noRunnableNote([row("1", "completed")])).toBe("Every task of this run is completed.");
  });

  test("progress is text, with the blocked count only when a task is blocked", () => {
    expect(progress([row("1", "completed"), row("2", "pending", "no access"), row("3", "pending")])).toEqual({ done: "1/3 done", blocked: "1 blocked" });
    expect(progress([row("1", "completed"), row("2", "pending")])).toEqual({ done: "1/2 done", blocked: "" });
  });

  test("each continuation state has its own line, and off says why only while tasks are open", () => {
    const open = [row("1", "completed"), row("2", "pending")];
    expect(continuationLine(off, [row("1", "completed"), row("2", "pending", "no access")])).toBeUndefined();
    expect(continuationLine(off, open)).toEqual({ text: "This session is not continuing these tasks", warning: false });
    expect(continuationLine({ state: "off", reason: "OMCA_DISABLED_HOOKS turns continuation off" }, open)).toEqual({ text: "OMCA_DISABLED_HOOKS turns continuation off.", warning: true });
    expect(continuationLine({ state: "on", reason: "" }, open)).toEqual({ text: "Continues while tasks stay open", warning: false });
    expect(continuationLine({ state: "paused", reason: "the last message asked to pause" }, open)).toEqual({ text: "Paused: your last message asked to pause. Send a message to resume.", warning: true });
    expect(continuationLine({ state: "stopped", reason: "3 continuations in a row got no tool call" }, open)).toEqual({ text: "Stopped: 3 continuations in a row got no tool call. Send a message to resume.", warning: true });
    expect(continuationLine({ state: "stopped", reason: "too many rounds.\u001b[2J" }, open)?.text).toBe("Stopped: too many rounds.[2J. Send a message to resume.");
    expect(continuationLine({ state: "stopped", reason: "" }, open)?.text).toBe("Stopped. Send a message to resume.");
  });
});

describe("the prompt footer status", () => {
  const tasks = [row("1", "completed"), row("2", "pending", "no access"), row("3", "pending")];

  test("counts done tasks and adds the blocked marker, a space and the count in every glyph tier", () => {
    expect(footerStatus(tasks, off, glyphs("unicode"))).toEqual({ count: "OMCA 1/3", blocked: " ⊗ 1", hold: "" });
    expect(footerStatus(tasks, off, glyphs("ascii"))).toEqual({ count: "OMCA 1/3", blocked: " % 1", hold: "" });
    expect(footerStatus(tasks, off, glyphs("nerd")).blocked).toBe(" \u{f05e} 1");
  });

  test("stays plain with none blocked and names a held continuation", () => {
    expect(footerStatus([row("1", "completed"), row("2", "pending")], off, glyphs("unicode"))).toEqual({ count: "OMCA 1/2", blocked: "", hold: "" });
    expect(footerStatus(tasks, { state: "on", reason: "" }, glyphs("unicode")).hold).toBe("");
    expect(footerStatus(tasks, { state: "paused", reason: "x" }, glyphs("unicode")).hold).toBe(" paused");
    expect(footerStatus(tasks, { state: "stopped", reason: "x" }, glyphs("unicode")).hold).toBe(" stopped");
  });
});

test("each evidence verdict reads as what it is", () => {
  expect(verdictText("missing")).toBe("no final verification");
  expect(verdictText("historical")).toBe("matching run history");
  expect(verdictText("stale")).toBe("earlier run history");
  expect(verdictText("verified")).toBe("verified");
});

test("an RPC error object shows its message, not [object Object]", () => {
  expect(errorText({ type: "RpcTimeout", message: "The request timed out" })).toBe("The request timed out");
  expect(errorText(new Error("RPC unavailable"))).toBe("RPC unavailable");
  expect(errorText("plain\u0007 text")).toBe("plain text");
  expect(errorText({ type: "Unknown" })).toBe("Snapshot unavailable.");
  expect(errorText(undefined)).toBe("Snapshot unavailable.");
});

describe("panel layout", () => {
  test("f is offered only where the host can split the screen", () => {
    expect(canToggleFullscreen("panel", 60)).toBe(true);
    expect(canToggleFullscreen("fullscreen", 120)).toBe(true);
    expect(canToggleFullscreen("fullscreen", 108)).toBe(true);
    expect(canToggleFullscreen("fullscreen", 107)).toBe(false);
  });

  test("hints drop whole from the end and never cut a key or label", () => {
    const hints = [{ key: "enter", label: "open" }, { key: "↑↓", label: "move" }, { key: "r", label: "refresh" }];
    expect(fitHints(hints, 40)).toEqual(hints);
    expect(fitHints(hints, 19)).toEqual(hints.slice(0, 2));
    expect(fitHints(hints, 18)).toEqual(hints.slice(0, 1));
    expect(fitHints(hints, 9)).toEqual([]);
  });

  test("row facts drop whole from the end", () => {
    expect(fitParts(["exit 0", "11-18 14:02", "Test"], 40)).toBe("exit 0 · 11-18 14:02 · Test");
    expect(fitParts(["exit 0", "11-18 14:02", "Test"], 20)).toBe("exit 0 · 11-18 14:02");
    expect(fitParts(["exit 0", "", "Test"], 13)).toBe("exit 0 · Test");
    expect(fitParts(["exit 0", "11-18 14:02"], 6)).toBe("exit 0");
    expect(fitParts(["exit 0"], 5)).toBe("");
  });

  test("tab chips keep every name when they fit, else the active name and the digits", () => {
    const labels = (active: Parameters<typeof chipLabels>[0], room: number) => chipLabels(active, room).map((chip) => chip.label);
    expect(labels("Tasks", 50)).toEqual(["1 Tasks", "2 Agents", "3 Evidence", "4 Notepad", "5 Doctor"]);
    expect(labels("Evidence", 49)).toEqual(["1", "2", "3 Evidence", "4", "5"]);
    expect(chipLabels("Evidence", 49).map((chip) => chip.tab)).toEqual(["Tasks", "Agents", "Evidence", "Notepad", "Doctor"]);
  });

  test("a long list keeps a row for the rest, and the cursor stays inside the list", () => {
    expect(capList([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(capList([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2], more: 3 });
    expect(clampCursor(5, 3)).toBe(2);
    expect(clampCursor(-1, 3)).toBe(0);
    expect(clampCursor(2, 0)).toBe(0);
  });
});

describe("the Agents tab", () => {
  test("names agents in title case", () => {
    expect(agentLabel("omca")).toBe("OMCA");
    expect(agentLabel("omca-executor")).toBe("Executor");
    expect(agentLabel("general")).toBe("General");
    expect(agentLabel(undefined)).toBe("Session");
  });

  test("puts working sessions first and counts each cost once", () => {
    const members = [{ id: "root" }, { id: "a", parentID: "root" }, { id: "b", parentID: "root" }, { id: "c", parentID: "a" }];
    const own: Record<string, number> = { a: 0.25, b: 0.5, c: 0.125 };
    const { rows, total } = agentRows(members, (id) => id === "b" || id === "c", (id) => (id === "root" ? 1 : own[id]!));
    expect(rows.map((item) => [item.session.id, item.running, item.cost])).toEqual([["b", true, 0.5], ["c", true, 0.125], ["root", false, 0.125], ["a", false, 0.25]]);
    expect(total).toBe(1);
    expect(rows.reduce((sum, item) => sum + item.cost, 0)).toBe(total);
  });
});

test("server strings cannot inject terminal control bytes", () => {
  expect(plain("title\u001b]52;c;value\u0007\r\nlabel\ttext\u009b")).toBe("title]52;c;value\nlabel\ttext");
});

describe("snapshot refresh coordination", () => {
  test("coalesces invalidations into one follow-up without parallel requests", async () => {
    const h = harness();
    h.reader.select(target("one"));
    h.reader.refresh();
    h.reader.refresh();
    h.reader.select(target("one"));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.signal.aborted).toBe(false);
    h.calls[0]!.resolve("first");
    await tick();
    expect(h.calls).toHaveLength(2);
    expect(h.latest()?.updating).toBe(false);
    h.calls[1]!.resolve("second");
    await tick();
    expect(h.latest()).toMatchObject({ phase: "ready", updating: false, value: "second" });
    h.reader.dispose();
  });

  test("switches immediately and keeps obsolete completions from releasing the current request", async () => {
    const h = harness();
    h.reader.select(target("one"));
    h.reader.select(target("two"));
    h.reader.select(target("two", "/worktree"));
    expect(h.calls).toHaveLength(3);
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.calls[1]!.signal.aborted).toBe(true);
    expect(h.calls[2]!.signal.aborted).toBe(false);
    expect(h.calls[2]!.target).toEqual(target("two", "/worktree"));
    expect(h.latest()).toMatchObject({ key: targetKey(target("two", "/worktree")), phase: "loading", value: undefined });
    h.reader.refresh();
    h.calls[0]!.resolve("wrong session");
    h.calls[1]!.reject(new Error("obsolete location"));
    await tick();
    expect(h.latest()).toMatchObject({ phase: "loading", value: undefined, error: undefined });
    expect(h.calls).toHaveLength(3);
    h.calls[2]!.resolve("right checkout");
    await tick();
    expect(h.calls).toHaveLength(4);
    expect(h.latest()).toMatchObject({ value: "right checkout", updating: false });
    h.calls[3]!.resolve("refreshed checkout");
    await tick();
    expect(h.latest()).toMatchObject({ phase: "ready", value: "refreshed checkout", updating: false });
    h.reader.dispose();
  });

  test("copies a mutable location and clears the old checkout value before a failed refresh", async () => {
    const h = harness();
    const selected = target("one");
    h.reader.select(selected);
    h.calls[0]!.resolve("old checkout");
    await tick();
    selected.location.directory = "/worktree";
    selected.location.workspaceID = "workspace-two";
    h.reader.select(selected);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.target.location).toEqual({ directory: "/checkout" });
    expect(h.calls[1]!.target.location).toEqual({ directory: "/worktree", workspaceID: "workspace-two" });
    expect(h.latest()).toMatchObject({ key: targetKey(selected), phase: "loading", value: undefined });
    h.calls[1]!.reject(new Error("RPC unavailable"));
    await tick();
    expect(h.latest()).toMatchObject({ key: targetKey(selected), phase: "error", value: undefined, error: "RPC unavailable" });
    h.reader.refresh();
    h.calls[2]!.resolve("right checkout");
    await tick();
    expect(h.latest()?.value).toBe("right checkout");
    h.reader.dispose();
  });

  test("changing only the workspace starts a new request and aborts the old one", async () => {
    const h = harness();
    const selected = target("one");
    h.reader.select(selected);
    selected.location.workspaceID = "workspace-two";
    h.reader.select(selected);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.calls[0]!.target.location).toEqual({ directory: "/checkout" });
    h.calls[1]!.resolve("current workspace");
    await tick();
    h.calls[0]!.resolve("obsolete workspace");
    await tick();
    expect(h.latest()).toMatchObject({ key: targetKey(selected), value: "current workspace" });
    h.reader.dispose();
  });

  test("a round trip to the same key still rejects the old generation", async () => {
    const h = harness();
    h.reader.select(target("one"));
    h.reader.select(target("two"));
    h.reader.select(target("one"));
    expect(h.calls).toHaveLength(3);
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.calls[1]!.signal.aborted).toBe(true);
    h.calls[0]!.resolve("obsolete");
    await tick();
    expect(h.updates.some((state) => state?.value === "obsolete")).toBe(false);
    expect(h.calls).toHaveLength(3);
    h.calls[2]!.resolve("current");
    await tick();
    expect(h.latest()?.value).toBe("current");
    h.reader.dispose();
  });

  test("retains stale data on transport error and allows explicit recovery", async () => {
    const h = harness();
    h.reader.select(target("one"));
    h.calls[0]!.resolve("cached");
    await tick();
    h.reader.refresh();
    h.calls[1]!.reject({ type: "RpcError", message: "RPC unavailable" });
    await tick();
    expect(h.latest()).toMatchObject({ phase: "error", updating: false, value: "cached", error: "RPC unavailable" });
    h.reader.refresh(true);
    expect(h.latest()).toMatchObject({ phase: "error", updating: true, value: "cached" });
    h.calls[2]!.resolve("reconnected");
    await tick();
    expect(h.latest()).toMatchObject({ phase: "ready", updating: false, value: "reconnected", error: undefined });
    h.reader.dispose();
  });

  test("only a refresh the user asked for reads as updating, until a read started after it settles", async () => {
    const h = harness();
    h.reader.select(target("one"));
    h.calls[0]!.resolve("first");
    await tick();
    h.reader.refresh();
    expect(h.latest()).toMatchObject({ phase: "ready", updating: false, value: "first" });
    h.reader.refresh(true);
    expect(h.latest()).toMatchObject({ updating: true, value: "first" });
    h.calls[1]!.resolve("timer read");
    await tick();
    expect(h.latest()).toMatchObject({ updating: true, value: "timer read" });
    expect(h.calls).toHaveLength(3);
    h.reader.refresh();
    h.calls[2]!.resolve("user read");
    await tick();
    expect(h.latest()).toMatchObject({ updating: false, value: "user read" });
    h.calls[3]!.resolve("timer again");
    await tick();
    expect(h.latest()).toMatchObject({ updating: false, value: "timer again" });
    h.reader.dispose();
  });

  test("leaving the session clears state and prevents queued work", async () => {
    const h = harness();
    h.reader.select(target("one"));
    h.reader.refresh();
    h.reader.select(undefined);
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.latest()).toBeUndefined();
    h.calls[0]!.reject(new Error("late error"));
    await tick();
    expect(h.latest()).toBeUndefined();
    expect(h.calls).toHaveLength(1);
    h.reader.refresh();
    expect(h.calls).toHaveLength(1);
    h.reader.dispose();
  });

  test("unmount ignores late responses and releases queued refreshes", async () => {
    const h = harness();
    h.reader.select(target("one"));
    h.reader.refresh();
    h.reader.dispose();
    expect(h.calls[0]!.signal.aborted).toBe(true);
    const before = h.updates.length;
    h.calls[0]!.resolve("late");
    await tick();
    h.reader.select(target("two"));
    h.reader.refresh();
    expect(h.updates).toHaveLength(before);
    expect(h.calls).toHaveLength(1);
  });
});
