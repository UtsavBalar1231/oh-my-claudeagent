import { describe, expect, test } from "bun:test";
import { parseClipManifest } from "./clip-manifest.ts";
import { type Clip, CLIPS, locate, SHOTS } from "./screenshots.ts";

const still = (name: string) => SHOTS.find((shot) => shot.name === name);
const clip = (name: string) => CLIPS.find((shot) => shot.name === name);

describe("SHOTS", () => {
  test("names are unique file stems and every shot fits a real terminal", () => {
    const names = [...SHOTS, ...CLIPS].map((shot) => shot.name);
    expect(new Set(names).size).toBe(names.length);
    for (const shot of [...SHOTS, ...CLIPS]) {
      expect(shot.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(shot.cols).toBeGreaterThanOrEqual(80);
      expect(shot.rows).toBeGreaterThanOrEqual(20);
    }
  });

  test("captures every README scene as a still and the two animated scenes as GIFs", () => {
    expect(SHOTS.filter((shot) => shot.format === "png").map((shot) => shot.name)).toEqual(["hero", "band", "plan", "evidence", "agents", "guard", "doctor", "statusline"]);
    expect(SHOTS.filter((shot) => shot.format === "gif").map((shot) => shot.name)).toEqual(["pane-tour", "guard-dialog"]);
  });

  test("the plan scene is ready only once the executor holds task 7 and task 6 is focused", () => {
    const board = "◆ executor on 7\n◐ 7 Wire the order summary panel  UNPROVEN\n↑↓ move · enter open";
    expect(still("plan")?.ready(`${board}\n6. Build the payment step`)).toBe(true);
    expect(still("plan")?.ready(board)).toBe(false);
  });

  test("only the pane scenes crop to the pane", () => {
    expect(SHOTS.filter((shot) => shot.crop === "pane").map((shot) => shot.name)).toEqual(["plan", "evidence", "agents", "doctor"]);
  });

  test("the guard scenes are ready only once the dialog holds the command", () => {
    for (const name of ["guard", "guard-dialog"]) {
      expect(still(name)?.ready("● Removing the build output\nOMCA held this command for your review:")).toBe(true);
      expect(still(name)?.ready("● Removing the build output")).toBe(false);
    }
  });
});

describe("CLIPS", () => {
  const untils = (shot: Clip | undefined) => shot?.steps.flatMap((step) => ("until" in step ? [step] : [])) ?? [];
  const marks = (shot: Clip | undefined) => untils(shot).flatMap((step) => (step.mark === undefined ? [] : [step.mark]));
  const targets = (shot: Clip | undefined) => untils(shot).flatMap((step) => Object.keys(step.targets ?? {}));
  const target = (shot: Clip | undefined, name: string) => untils(shot).find((step) => step.targets?.[name])?.targets?.[name];

  test("records the video scenes as clips", () => {
    expect(CLIPS.map((shot) => shot.name)).toEqual([
      "clip-plain-stop",
      "clip-plain-reset",
      "clip-refusal",
      "clip-plan",
      "clip-delegate",
      "clip-board",
      "clip-guard",
      "clip-verify",
      "clip-board-light",
      "clip-tour",
    ]);
    const pairs = ["clip-plain-stop", "clip-plain-reset", "clip-refusal", "clip-guard"];
    for (const shot of CLIPS) expect([shot.name, shot.cols, shot.rows, shot.font]).toEqual(pairs.includes(shot.name) ? [shot.name, 96, 34, 35] : [shot.name, 200, 50, undefined]);
  });

  test("each clip marks the events and names the targets its beat needs", () => {
    expect(marks(clip("clip-plain-stop"))).toEqual(["cmd-typed", "claim-done", "shell-typed", "open-tasks"]);
    expect(targets(clip("clip-plain-stop"))).toEqual(["claim-line", "open-list"]);
    expect(marks(clip("clip-plain-reset"))).toEqual(["cmd-typed", "reset-ran"]);
    expect(targets(clip("clip-plain-reset"))).toEqual(["reset-call", "lost-files", "bypass-mode"]);
    expect(marks(clip("clip-refusal"))).toEqual(["cmd-typed", "claim-done", "stop-feedback", "resumed"]);
    expect(targets(clip("clip-refusal"))).toEqual(["claim-line", "stop-line"]);
    expect(marks(clip("clip-plan"))).toEqual(["cmd-typed", "dialog", "key-choice", "plan-written"]);
    expect(targets(clip("clip-plan"))).toEqual(["question"]);
    expect(marks(clip("clip-delegate"))).toEqual(["cmd-typed", "spawned", "pane", "lanes"]);
    expect(targets(clip("clip-delegate"))).toEqual(["tool-row", "lane-model"]);
    for (const name of ["clip-board", "clip-board-light"]) {
      expect(marks(clip(name))).toEqual(["cmd-typed", "board", "focus-moved", "task-open"]);
      expect(targets(clip(name))).toEqual(["proven-chip", "unproven-chip"]);
    }
    expect(marks(clip("clip-guard"))).toEqual(["cmd-typed", "dialog", "refused"]);
    expect(targets(clip("clip-guard"))).toEqual(["discard-lines"]);
    expect(marks(clip("clip-verify"))).toEqual(["cmd-typed", "tests-pass", "evidence-logged", "complete"]);
    expect(marks(clip("clip-tour"))).toEqual(["cmd-typed", "agents-tab", "plan-tab", "evidence-tab", "notepad-tab", "stats-tab", "feedback-tab", "rated"]);
    expect(targets(clip("clip-verify"))).toEqual(["complete-chip", "verdict-line"]);
    expect(targets(clip("clip-tour"))).toEqual(["band", "cost-row", "notepad-card", "stats-header"]);
  });

  // Each row is a split screen: the transcript, the pane's edge at column 12, then the pane.
  test.each([
    ["clip-tour", "band", "██ 6/14 · next 7 Wire the panel · 1 running     [-]│pane", { row: 0, col: 3, len: 40, rows: 1 }],
    ["clip-tour", "cost-row", "  ↯ 6/14\n  $0.04 · ⏱ 11s", { row: 1, col: 2, len: 7, rows: 1 }],
    ["clip-tour", "notepad-card", "│╭── x ──╮\n│╭────╮ ╭────╮\n││ Learnings · 3 entries", { row: 1, col: 1, len: 6, rows: 1 }],
    ["clip-tour", "stats-header", "abc│  agent   runs  median  tokens  est. cost  evidence  outcomes   │", { row: 0, col: 6, len: 59, rows: 1 }],
    ["clip-delegate", "lane-model", "x │ executor · Wire the panel    sonnet-5-5  high       7s", { row: 0, col: 33, len: 25, rows: 1 }],
    ["clip-verify", "verdict-line", "x │  COMPLETE  matches the current plan · 10-04 13:35   │", { row: 0, col: 5, len: 48, rows: 1 }],
  ])("%s's %s target finds one row", (name, targetName, screen, span) => {
    expect(locate(screen, target(clip(name), targetName) ?? /^$/)).toEqual(span);
  });

  test("the plain clips leave the plugin out and pair with an OMCA clip on the same prompt", () => {
    expect(CLIPS.filter((shot) => shot.plugin === false).map((shot) => shot.name)).toEqual(["clip-plain-stop", "clip-plain-reset"]);
    const prompt = (shot: Clip | undefined) => shot?.steps.find((step) => "type" in step);
    expect(prompt(clip("clip-plain-stop"))).toEqual(prompt(clip("clip-refusal")));
    expect(prompt(clip("clip-plain-reset"))).toEqual(prompt(clip("clip-guard")));
  });

  test("the reset pair runs under bypassPermissions", () => {
    const bypassed = CLIPS.filter((shot) => shot.args?.join(" ").includes("--permission-mode bypassPermissions")).map((shot) => shot.name);
    expect(bypassed).toEqual(["clip-plain-reset", "clip-guard"]);
  });

  test("only the refusal and the verification run with the Stop gates on", () => {
    expect(CLIPS.filter((shot) => shot.env?.["OMCA_DISABLED_HOOKS"] === "").map((shot) => shot.name)).toEqual(["clip-refusal", "clip-verify"]);
  });

  test("the board target tells a PROVEN chip from an UNPROVEN one", () => {
    const screen = "7 Wire  UNPROVEN\n1 Add the cart  PROVEN";
    expect(locate(screen, target(clip("clip-board"), "proven-chip") ?? /^$/)).toEqual({ row: 1, col: 16, len: 6, rows: 1 });
  });

  test("a target over two rows spans from its leftmost text, skipping the indent", () => {
    const screen = "● Ran 1 stop hook\n  ⎿  Stop hook feedback: the bound plan\n  still has 8 unchecked tasks\n\n● Task 7 is still open";
    expect(locate(screen, target(clip("clip-refusal"), "stop-line") ?? /^$/)).toEqual({ row: 1, col: 2, len: 37, rows: 2 });
  });

  test("a dialog gutter counts as indent", () => {
    const screen = [
      "│ git reset --hard discards 2 uncommitted changes:",
      "│   src/steps/payment.ts | 2 +-",
      "│   src/steps/summary.ts | 4 +++-",
      "│   2 files changed, 4 insertions(+), 2 deletions(-)",
      "│ Run it?",
    ].join("\n");
    expect(locate(screen, target(clip("clip-guard"), "discard-lines") ?? /^$/)).toEqual({ row: 0, col: 2, len: 48, rows: 3 });
  });
});

describe("parseClipManifest", () => {
  const manifest = {
    scene: "clip-guard",
    fps: 30,
    width: 3520,
    height: 1780,
    frames: 300,
    grid: { cols: 200, rows: 50 },
    cell: { width: 17, height: 34 },
    origin: { x: 16, y: 16 },
    marks: { "cmd-typed": 40, dialog: 120 },
    targets: { "removal-lines": { row: 20, col: 4, len: 30, rows: 2, from: 120, to: 299 } },
  };

  test("reads a manifest the harness writes", () => {
    expect(parseClipManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  test("refuses a mark or a target past the last frame", () => {
    expect(() => parseClipManifest(JSON.stringify({ ...manifest, marks: { dialog: 300 } }))).toThrow("marks.dialog is past the last frame");
    expect(() => parseClipManifest(JSON.stringify({ ...manifest, targets: { x: { ...manifest.targets["removal-lines"], from: 10, to: 5 } } }))).toThrow("ends before it starts");
  });
});
