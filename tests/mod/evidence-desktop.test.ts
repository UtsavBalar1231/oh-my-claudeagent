import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { ENTRY_CAP } from "../../hooks/tabs/evidence.ts";
import { childrenOf, isNode, LEDGER, nodeByKey, pane, run, textOf, topRows, world } from "./world.ts";

const entry = (n: number, exit: number, at: Date) => ({
  type: "test",
  command: `just check-${n}`,
  exit_code: exit,
  output_snippet: `ran ${n}`,
  timestamp: at.toISOString(),
  verified_by: "oh-my-claudeagent:executor",
});

const sameDay = (count: number, exit = 0) => Array.from({ length: count }, (_, n) => entry(n, exit, new Date(2026, 9, 2, 8, 0, n)));
const eachDay = (count: number) => Array.from({ length: count }, (_, n) => entry(n, 0, new Date(2026, 0, 1 + n, 8, 0, 0)));

async function openEvidence($: Engine, on: On, entries: unknown[]) {
  const w = world(on, { [LEDGER]: JSON.stringify({ entries }) });
  w.surfaces = ["desktop"];
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("desktop"));
  await ui.press({ key: "3" });
  await ui.redraw();
  return ui;
}

function entryKeys(element: unknown): string[] {
  if (!isNode(element)) return [];
  const key = element.props?.["key"];
  const own = typeof key === "string" && /^entry-\d+$/.test(key) ? [key] : [];
  return [...own, ...childrenOf(element).flatMap(entryKeys)];
}

const drawnIds = (tree: unknown) => entryKeys(tree).map((key) => Number(key.slice("entry-".length)));
const newest = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, n) => from - n);

const nodesIn = (element: unknown): number =>
  typeof element === "string" ? 1 : isNode(element) ? 1 + childrenOf(element).reduce<number>((sum, child) => sum + nodesIn(child), 0) : 0;

test("Evidence on desktop draws every entry of a short ledger and no cue that more are out of view", async ($, on) => {
  const ui = await openEvidence($, on, sameDay(5));
  const tree = await ui.drawn();
  expect(drawnIds(tree)).toEqual([4, 3, 2, 1, 0]);
  for (let n = 0; n < 5; n += 1) expect(textOf(nodeByKey(tree, `entry-${n}`))).toContain(`just check-${n}`);
  expect(nodeByKey(tree, "older")).toBeUndefined();
  expect(textOf(tree)).not.toContain("more");
  await ui.unmount();
});

test("Evidence on desktop draws one page of the newest entries, and its Buttons turn to the older page and back", async ($, on) => {
  const total = ENTRY_CAP * 2 + 10;
  const ui = await openEvidence($, on, sameDay(total));
  const labels = (tree: unknown) => [nodeByKey(tree, "newer")?.props?.["label"], nodeByKey(tree, "older")?.props?.["label"]];
  const first = await ui.drawn();
  expect(drawnIds(first)).toEqual(newest(total - 1, total - ENTRY_CAP));
  expect(labels(first)).toEqual([undefined, `Show ${ENTRY_CAP} older`]);
  await ui.press({ key: "older" });
  const second = await ui.drawn();
  expect(drawnIds(second)).toEqual(newest(total - 1 - ENTRY_CAP, total - ENTRY_CAP * 2));
  expect(labels(second)).toEqual([`Show ${ENTRY_CAP} newer`, "Show 10 older"]);
  await ui.press({ key: "older" });
  const third = await ui.drawn();
  expect(drawnIds(third)).toEqual(newest(9, 0));
  expect(labels(third)).toEqual([`Show ${ENTRY_CAP} newer`, undefined]);
  await ui.press({ key: "newer" });
  expect(drawnIds(await ui.drawn())).toEqual(newest(total - 1 - ENTRY_CAP, total - ENTRY_CAP * 2));
  await ui.unmount();
});

test("Evidence on desktop goes back to the newest page when the filter changes", async ($, on) => {
  const total = ENTRY_CAP + 10;
  const ui = await openEvidence($, on, sameDay(total, 1));
  await ui.press({ key: "older" });
  expect(drawnIds(await ui.drawn())).toEqual(newest(9, 0));
  await ui.press({ key: "x" });
  const tree = await ui.drawn();
  expect(drawnIds(tree)).toEqual(newest(total - 1, total - ENTRY_CAP));
  expect(nodeByKey(tree, "older")?.props?.["label"]).toBe("Show 10 older");
  await ui.unmount();
});

test("Evidence on desktop ends its tree with the key row, with no blank padding rows", async ($, on) => {
  const ui = await openEvidence($, on, sameDay(5));
  const rows = topRows(await ui.drawn());
  const last = rows.at(-1);
  expect(isNode(last) ? last.props?.["key"] : undefined).toBe("keys-0");
  expect(rows.filter((row) => isNode(row) && row.type === "Text" && textOf(row).trim() === "")).toEqual([]);
  await ui.unmount();
});

test("Evidence on desktop keeps the cap's entries on separate days, with their opened entry, under the 2,000 nodes Desktop accepts", async ($, on) => {
  const ui = await openEvidence($, on, eachDay(ENTRY_CAP + 1));
  expect(nodesIn(await ui.drawn())).toBeLessThan(2000);
  await ui.unmount();
});
