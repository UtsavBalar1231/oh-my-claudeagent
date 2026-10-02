import type { CommandSpec, On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { USAGE } from "../../hooks/feedback.ts";
import { usableColumns } from "../../src/core/ui-kit.ts";
import { bodyColumns, cellsAcross, pane, ROOT, rows, run, SESSION, SIZES, topRows, type World, world } from "./world.ts";

const FILE = `${ROOT}/.omca/feedback/${SESSION}.json`;
const AT = "2026-10-02T12:00:00.000Z";
const LONG_NOTE = "the footer named the wrong command after the plan reader reloaded the plan twice in one turn";

function engine(on: On): { w: World; registered: CommandSpec[] } {
  const w = world(on);
  const registered: CommandSpec[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => (registered.push(e), { value: { command: e.name } }));
  on("fs.write", (_$, e) => (w.files.set(w.spelled(e.path), { text: e.text, mtimeMs: w.clock.now() }), { value: undefined }));
  on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return { w, registered };
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });

const complete = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({
    answer: "done",
    durationMs: 1_000,
    isAborted: false,
    turnId,
    reason: "answer",
    ...(agentId === undefined ? {} : { agentId }),
  });

const rate = ($: Engine, args: string) => $.command.run({ ...run(args), command: "omca-rate" });

const saved = (ratings: readonly object[]) => `${JSON.stringify({ session_id: SESSION, ratings }, null, 2)}\n`;

const two = (value: number) => String(value).padStart(2, "0");
const local = (iso: string) => {
  const date = new Date(iso);
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
};

test("session start registers /omca-rate to run at once with its argument hint", async ($, on) => {
  const { registered } = engine(on);
  await start($);

  expect(registered.find((spec) => spec.name === "omca-rate")).toEqual({
    name: "omca-rate",
    description: "Rate the last OMCA turn up or down, with an optional note",
    argumentHint: "up|down [note]",
    immediate: true,
  });
});

test("/omca-rate rates the last main turn, keeping a note's inner spaces, and appends each rating", async ($, on) => {
  const { w } = engine(on);
  await start($);
  await complete($, "t-1");
  await complete($, "t-sub", "a-1");

  expect(await rate($, "up good")).toEqual({ text: 'Rated the last turn up: "good".' });
  await w.clock.advance(60_000);
  expect(await rate($, "  down   the diff  missed a file  ")).toEqual({
    text: 'Rated the last turn down: "the diff  missed a file".',
  });

  expect(w.files.get(FILE)?.text).toBe(
    saved([
      { turn_id: "t-1", at: AT, rating: "up", note: "good" },
      { turn_id: "t-1", at: "2026-10-02T12:01:00.000Z", rating: "down", note: "the diff  missed a file" },
    ]),
  );
});

test("before any turn completes, a rating is for the session and says so", async ($, on) => {
  const { w } = engine(on);
  await start($);

  expect(await rate($, "up")).toEqual({ text: "Rated the session (no turn yet) up." });
  expect(w.files.get(FILE)?.text).toBe(saved([{ turn_id: null, at: AT, rating: "up" }]));
});

test("a malformed argument is answered with the usage text and records nothing", async ($, on) => {
  const { w } = engine(on);
  await start($);

  for (const args of ["", "  ", "sideways", "upvote", "UP", "good up"]) {
    expect(await rate($, args)).toEqual({ text: "Usage: /omca-rate up|down [note]" });
  }
  expect(USAGE).toBe("Usage: /omca-rate up|down [note]");
  expect(w.files.has(FILE)).toBe(false);
});

test("a feedback file that does not parse is left as it is and the reason is answered", async ($, on) => {
  const { w } = engine(on);
  w.files.set(FILE, { text: "{ not json", mtimeMs: 1 });
  await start($);

  const { text } = await rate($, "up");
  expect(text).toStartWith("Could not record the rating: ");
  expect(w.files.get(FILE)?.text).toBe("{ not json");
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`the Feedback tab's Up and Down buttons rate the last turn as the command does, on the ${surface}`, async ($, on) => {
    const { w } = engine(on);
    await start($);
    await complete($, "t-1");
    await $.command.run(run(""));
    const ui = await $.ui.mount(pane(surface, { columns: 120, rows: 40, placement: "dock" }));
    const body = async () => rows(await ui.drawn()).slice(3);
    await ui.press({ key: "5" });
    expect(await body()).toEqual(["u: Up  d: Down  rate the last turn", "No feedback has been recorded in this session."]);

    await ui.press({ key: "u" });
    await w.clock.advance(60_000);
    await ui.press({ key: "d" });

    const later = "2026-10-02T12:01:00.000Z";
    expect(w.files.get(FILE)?.text).toBe(
      saved([
        { turn_id: "t-1", at: AT, rating: "up" },
        { turn_id: "t-1", at: later, rating: "down" },
      ]),
    );
    expect(await body()).toEqual([
      "u: Up  d: Down  rate the last turn",
      "2 ratings, newest first · 1 up, 1 down",
      `↓ down  ${local(later)}  `,
      `↑ up    ${local(AT)}  `,
    ]);
    await ui.unmount();
  });
}

test("the Feedback tab shows a note, a read failure and every row inside the gutter at each size", async ($, on) => {
  const { w } = engine(on);
  await start($);
  await complete($, "t-1");
  await rate($, `down ${LONG_NOTE}`);
  await $.command.run(run(""));

  for (const size of SIZES) {
    for (const surface of ["terminal", "desktop"] as const) {
      const room = usableColumns(bodyColumns(size));
      const ui = await $.ui.mount(pane(surface, size));
      await ui.press({ key: "5" });
      const drawn = rows(await ui.drawn());
      const row = drawn.find((text) => text.startsWith("↓ down"));
      expect(row?.startsWith(`↓ down  ${local(AT)}  the footer named`), `${size.columns} ${size.placement}`).toBe(true);
      for (const child of topRows(await ui.drawn())) {
        expect(cellsAcross(child), `${size.columns} ${size.placement} ${surface}`).toBeLessThanOrEqual(room);
      }
      await ui.unmount();
    }
  }

  w.files.set(FILE, { text: "[]", mtimeMs: 1 });
  await start($);
  const ui = await $.ui.mount(pane("terminal", { columns: 200, rows: 50, placement: "dock" }));
  await ui.press({ key: "5" });
  expect(rows(await ui.drawn()).slice(2)).toEqual([
    "u: Up  d: Down  rate the session (no turn yet)",
    "✗ Could not read this session's feedback: it holds no ratings list",
  ]);
  await ui.unmount();
});
