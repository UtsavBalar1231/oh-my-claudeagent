import { describe, expect, test } from "bun:test";
import { commandTab, plain, snapshotReader, targetKey, type ReadState, type Target } from "./tui-model.ts";

const target = (sessionID: string, directory = "/checkout"): Target => ({ sessionID, location: { directory } });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness() {
  const calls: Array<{ target: Target; signal: AbortSignal; resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  const updates: Array<ReadState<string> | undefined> = [];
  const reader = snapshotReader<string>((selected, signal) => new Promise((resolve, reject) => {
    calls.push({ target: selected, signal, resolve, reject });
  }), (state) => updates.push(state));
  return { reader, calls, updates, latest: () => updates.at(-1) };
}

test("/omca accepts only inspection tabs, with or without the slash prefix", () => {
  expect(commandTab()).toBe("Overview");
  expect(commandTab(" /omca  evidence ")).toBe("Evidence");
  expect(commandTab("doctor")).toBe("Doctor");
  expect(commandTab("plan")).toBe("Plan");
  expect(commandTab("agents")).toBe("Agents");
  expect(commandTab("notepad")).toBe("Notepad");
  expect(commandTab("start-work")).toBeUndefined();
  expect(commandTab("plan /other/file")).toBeUndefined();
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
    expect(h.latest()?.stale).toBe(true);
    h.calls[1]!.resolve("second");
    await tick();
    expect(h.latest()).toMatchObject({ phase: "ready", stale: false, value: "second" });
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
    expect(h.latest()).toMatchObject({ value: "right checkout", stale: true });
    h.calls[3]!.resolve("refreshed checkout");
    await tick();
    expect(h.latest()).toMatchObject({ phase: "ready", value: "refreshed checkout", stale: false });
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
    h.calls[1]!.reject(new Error("RPC unavailable"));
    await tick();
    expect(h.latest()).toMatchObject({ phase: "error", stale: true, value: "cached", error: "RPC unavailable" });
    h.reader.refresh();
    h.calls[2]!.resolve("reconnected");
    await tick();
    expect(h.latest()).toMatchObject({ phase: "ready", stale: false, value: "reconnected", error: undefined });
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
