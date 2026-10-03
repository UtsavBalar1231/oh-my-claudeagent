import type { CommandSpec, On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { usableColumns } from "../../src/core/ui-kit.ts";
import {
  bodyColumns,
  cellsAcross,
  isNode,
  local,
  pane,
  ROOT,
  rows,
  run,
  SESSION,
  SIZES,
  spreadRows,
  topRows,
  type World,
  world,
} from "./world.ts";

const FILE = `${ROOT}/.omca/feedback/${SESSION}.json`;
const AT = "2026-10-02T12:00:00.000Z";
const LONG_NOTE = "the footer named the wrong command after the plan reader reloaded the plan twice in one turn";

function engine(on: On, refuseWrites = false): { w: World; registered: CommandSpec[] } {
  const w = world(on);
  const registered: CommandSpec[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => (registered.push(e), { value: { command: e.name } }));
  on("fs.write", (_$, e) => {
    if (refuseWrites) return { deny: "EROFS: read-only file system" };
    w.files.set(w.spelled(e.path), { text: e.text, mtimeMs: w.clock.now() });
    return { value: undefined };
  });
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

test("/omca-rate with no note takes the selected text as the note, whitespace collapsed, and says so", async ($, on) => {
  const { w } = engine(on);
  await start($);
  await complete($, "t-1");
  w.selection = { text: "  the footer named\n  the wrong   command\n", requestId: "toolu_01" };

  expect(await rate($, "down")).toEqual({
    text: 'Rated the last turn down with the selected text as the note: "the footer named the wrong command".',
  });
  expect(w.files.get(FILE)?.text).toBe(
    saved([{ turn_id: "t-1", at: AT, rating: "down", note: "the footer named the wrong command" }]),
  );
});

test("a selection longer than 200 characters is cut to 200 ending in an ellipsis", async ($, on) => {
  const { w } = engine(on);
  await start($);
  w.selection = { text: "é".repeat(250) };

  await rate($, "up");
  const [entry] = JSON.parse(w.files.get(FILE)?.text ?? "{}").ratings;
  expect(entry.note).toBe(`${"é".repeat(199)}…`);
});

test("a typed note wins over a selection, which is not asked for its text", async ($, on) => {
  const { w } = engine(on);
  await start($);
  await complete($, "t-1");
  w.selection = { text: "selected words", requestId: "toolu_01" };

  expect(await rate($, "up typed words")).toEqual({ text: 'Rated the last turn up: "typed words".' });
  expect(w.files.get(FILE)?.text).toBe(saved([{ turn_id: "t-1", at: AT, rating: "up", note: "typed words" }]));
  expect(w.selectionReads).toBe(0);
});

test("with no note and nothing selected, or only blanks selected, the rating carries no note", async ($, on) => {
  const { w } = engine(on);
  await start($);
  await complete($, "t-1");

  expect(await rate($, "up")).toEqual({ text: "Rated the last turn up." });
  w.selection = { text: " \n " };
  expect(await rate($, "down")).toEqual({ text: "Rated the last turn down." });
  expect(w.files.get(FILE)?.text).toBe(
    saved([
      { turn_id: "t-1", at: AT, rating: "up" },
      { turn_id: "t-1", at: AT, rating: "down" },
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
  expect(w.files.has(FILE)).toBe(false);
});

test("a session id that cannot name a file records nothing and says why", async ($, on) => {
  const { w } = engine(on);
  w.sessionId = "../escape";
  await start($);

  expect(await rate($, "up")).toEqual({ text: 'Could not record the rating: the session id "../escape" cannot name a file' });
  expect([...w.files.keys()].filter((path) => path.includes("/.omca/feedback/"))).toEqual([]);
});

test("a rating the file system refuses to write is answered with the reason", async ($, on) => {
  const { w } = engine(on, true);
  await start($);
  await complete($, "t-1");

  expect(await rate($, "down")).toEqual({ text: "Could not record the rating: EROFS: read-only file system" });
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
    const body = async () => spreadRows(await ui.drawn()).slice(3);
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
      "2 ratings, newest first · ↑ 1 up · ↓ 1 down",
      ` ↓ DOWN  ${local(later)}  `,
      ` ↑ UP    ${local(AT)}  `,
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
      const drawn = spreadRows(await ui.drawn());
      const row = drawn.find((text) => text.startsWith(" ↓ DOWN"));
      expect(row?.startsWith(` ↓ DOWN  ${local(AT)}  the footer named`), `${size.columns} ${size.placement}`).toBe(true);
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

const piece = (props: Record<string, unknown>, run: string) => ({ type: "Text", ...(Object.keys(props).length === 0 ? {} : { props }), children: [run] });
const lit = (props: Record<string, unknown>, run: string) => ({ ...piece(props, run), hover: { color: "text" } });
const ratingRow = (key: string, ...pieces: unknown[]) => ({
  type: "Box",
  props: { key, flexDirection: "row" },
  hover: { backgroundColor: "selectionBg" },
  children: [{ type: "Text", props: { wrap: "truncate-end" }, children: pieces }],
});

test("the ratings card is tinted by whether any rating is down, each row a verdict chip, a muted time and the note with secrets masked", async ($, on) => {
  const { w } = engine(on);
  await start($);
  await complete($, "t-1");
  await rate($, "up");
  await w.clock.advance(60_000);
  await rate($, "down the deploy printed password=hunter2 again");
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 200, rows: 50, placement: "dock" }));
  await ui.press({ key: "5" });
  const later = "2026-10-02T12:01:00.000Z";

  expect(topRows(await ui.drawn()).at(-1)).toEqual({
    type: "Box",
    props: { key: "ratings", flexDirection: "column", borderStyle: "round", borderColor: "warning", paddingX: 1, width: 85 },
    children: [
      piece({ bold: true, color: "text", wrap: "truncate-end" }, "2 ratings, newest first · ↑ 1 up · ↓ 1 down"),
      ratingRow(
        "rating-0",
        piece({ color: "inverseText", backgroundColor: "error", bold: true }, " ↓ DOWN "),
        lit({}, " "),
        lit({ color: "inactive" }, `${local(later)}  `),
        lit({}, "the deploy printed password=‹masked› again"),
      ),
      ratingRow(
        "rating-1",
        piece({ color: "inverseText", backgroundColor: "success", bold: true }, " ↑ UP "),
        lit({}, "   "),
        lit({ color: "inactive" }, `${local(AT)}  `),
      ),
    ],
  });
  await ui.unmount();
});

test("all-up ratings draw the card in the ok tone, and a short body names the ratings it cut", async ($, on) => {
  const { w } = engine(on);
  for (let at = 0; at < 9; at += 1) {
    await rate($, "up");
    await w.clock.advance(60_000);
  }
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 80, rows: 40, placement: "inline" }));
  await ui.press({ key: "5" });

  const card = topRows(await ui.drawn()).at(-1);
  expect(isNode(card) ? card.props?.["borderColor"] : undefined).toBe("success");
  expect(spreadRows(await ui.drawn()).slice(1)).toEqual([
    "u: Up  d: Down  rate the session (no turn yet)",
    "9 ratings, newest first · ↑ 9 up · ↓ 0 down",
    ` ↑ UP    ${local("2026-10-02T12:08:00.000Z")}  `,
    ` ↑ UP    ${local("2026-10-02T12:07:00.000Z")}  `,
    ` ↑ UP    ${local("2026-10-02T12:06:00.000Z")}  `,
    ` ↑ UP    ${local("2026-10-02T12:05:00.000Z")}  `,
    ` ↑ UP    ${local("2026-10-02T12:04:00.000Z")}  `,
    "↓ 4 more",
  ]);
  await ui.unmount();
});

test("OMCA_GLYPHS=ascii draws the verdict chips and arrows from the ASCII set", async ($, on) => {
  const w = world(on, {}, {}, { OMCA_GLYPHS: "ascii" });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("fs.write", (_$, e) => (w.files.set(w.spelled(e.path), { text: e.text, mtimeMs: w.clock.now() }), { value: undefined }));
  await start($);
  await rate($, "down");
  await rate($, "up");
  await $.command.run(run(""));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 40, placement: "dock" }));
  await ui.press({ key: "5" });
  expect(spreadRows(await ui.drawn()).slice(4)).toEqual([
    "2 ratings, newest first - ^ 1 up - v 1 down",
    `[^ UP]   ${local(AT)}  `,
    `[v DOWN] ${local(AT)}  `,
  ]);
  await ui.unmount();
});
