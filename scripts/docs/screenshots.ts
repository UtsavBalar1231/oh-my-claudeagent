#!/usr/bin/env bun
// Captures the README screens from real Claude Code sessions against the scripted mock model. Each
// session runs in tmux, and kitty draws it on a private Xvfb display, so every image is a pixel
// grab of a real terminal: a PNG still, or a GIF recorded while the scripted keys are typed.
//
// A clip is footage for the video: a denser terminal recorded at a constant 30 fps into a BT.709
// MP4, with a manifest of the frames at which its states first appeared.
//
// Usage: bun scripts/docs/screenshots.ts [<name>... | clips] [--out <dir>]
// With no name it captures the README shots into .github/assets; clips go to video/public/footage.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Subprocess } from "bun";
import { packageTree } from "../package.ts";
import { cleanupOnSignal, REPO } from "../qa/lib.ts";
import { type Script, startServer } from "../qa/mock-model.ts";
import { exited, mockSessionEnv, quote, reachPrompt, sessionEnv, teardown, TERMINAL_OPTIONS, Tmux, TRUECOLOR_ENV } from "../qa/visual.ts";
import type { ClipManifest } from "./clip-manifest.ts";
import { assertPrivate, machineValues, SCRATCH_PREFIX } from "./privacy.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "acme-app");
const ASSET_DIR = join(REPO, ".github", "assets");
const FOOTAGE_DIR = join(REPO, "video", "public", "footage");
const SOCKET = `omca-shots-${process.pid}`;
const KITTY_CLASS = "omca-shots";
const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const PLAN_NAME = "checkout-redesign";
const POLL_MS = 150;
const READY_TIMEOUT_MS = 30_000;
const WINDOW_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 120_000;
const FONT_FAMILIES = ["JetBrainsMono Nerd Font Mono", "JetBrains Mono"] as const;
const FONT_SIZE = 14;
const PADDING = 12;
const DPI = 96;
// kitty reads its padding in points.
const PADDING_PX = Math.round((PADDING * DPI) / 72);
const SCREEN = "3840x2160x24";
// Dense enough that a 2x zoom of a 200-column clip inside a 1080p composition stays sharp: 16
// footage pixels a column.
const CLIP_FONT_SIZE = 22;
const CLIP_MIN_CELL_PX = 16;
const CLIP_FPS = 30;
const CLIP_POLL_MS = 50;
const CLIP_KEY_GAP_MS = 1_200;
const TRANSCODE_TIMEOUT_MS = 900_000;
// Untagged BT.601 footage shifts colors in Remotion. ffmpeg 9 lets a frame's unset primaries and
// transfer override -color_primaries and -color_trc, so setparams tags the frames themselves.
const CLIP_ENCODE = [
  "-vf", `fps=${CLIP_FPS},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709`,
  "-fps_mode", "cfr", "-r", String(CLIP_FPS),
  "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-g", String(CLIP_FPS),
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
  "-movflags", "+faststart", "-an",
];
// The mock answers at once; a pause before each reply lets every model turn land on its own frames.
const CLIP_MODEL_MS = 1_500;
const LIGHT_TERMINAL = ["-o", "background=#ffffff", "-o", "foreground=#1f1f1f"];
const FIRST_DISPLAY = 100;
const RECORD_FPS = 15;
const GIF_FPS = 10;
const TYPE_MS = 70;
const KEY_PAUSE_MS = 1_400;
const HOLD_MS = 2_500;
// kitty paints a tmux redraw on its next frame; this covers a few frames at its default 60 Hz.
const PAINT_MS = 400;
// Recorded clips showed a state up to 3 frames after the poll that first saw it, so a mark this far
// past the poll never lands on the frame before the state.
const CLIP_PAINT_MS = 100;

type Scene = {
  name: string;
  cols: number;
  rows: number;
  // A function gets the project's absolute path once the project is written.
  script: Script | ((project: string) => Script);
  settings?: Record<string, unknown>;
  // A directory under fixtures/ copied over acme-app.
  fixture?: string;
  theme?: "light";
  allow?: readonly string[];
  // Overrides the session environment, OMCA_DISABLED_HOOKS=stop-gates included.
  env?: Readonly<Record<string, string>>;
  // Points, for a clip whose columns must stay dense at a narrower width.
  font?: number;
  // false runs plain Claude Code: no --plugin-dir and no OMCA status line.
  plugin?: false;
  args?: readonly string[];
};

export type Still = Scene & {
  format: "png" | "gif";
  command: string;
  keys: readonly string[];
  ready: (screen: string) => boolean;
  // "pane" keeps only the docked OMCA pane, so its text stays readable at README width.
  crop?: "pane";
};

// A mark is the frame at which its predicate first held on the tmux screen, plus CLIP_PAINT_MS; each
// target is the text a pattern finds on that screen, followed for as long as it stays put.
export type Step =
  | { type: string }
  | { key: string; gap?: number }
  | { until: (screen: string) => boolean; hold?: number; mark?: string; targets?: Readonly<Record<string, RegExp>> };

export type Clip = Scene & { format: "clip"; steps: readonly Step[] };

export type Shot = Still | Clip;

const text = (value: string) => ({ type: "text" as const, text: value });
const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use" as const, name, input });
const bash = (command: string, description: string) => tool("Bash", { command, description });
const agent = (type: string, description: string, prompt: string, background = true) =>
  tool("Agent", { subagent_type: `oh-my-claudeagent:${type}`, description, prompt, ...(background && { run_in_background: true }) });
const executor = (description: string, prompt: string) => agent("executor", description, prompt);

// The justfile's watch recipe sleeps, so an agent that reaches it keeps running through the capture.
const WATCH_SUMMARY = bash("just watch summary", "Run the summary tests in watch mode");
const TASK_7 = executor("Wire the order summary panel", "Task 7: wire the order summary panel into the payment step.");
const PLAN_SCRIPT: Script = {
  main: [
    { content: [text("Task 7 is next: tasks 1 and 6 are done. I will hand it to the executor."), TASK_7] },
    { content: [text("The executor is on task 7. Tasks 8, 9 and 11 are open as well.")] },
  ],
  subagent: [
    { content: [tool("Read", { file_path: "src/steps/summary.ts" })] },
    { content: [tool("Grep", { pattern: "total", path: "src/cart" })] },
    { content: [WATCH_SUMMARY] },
  ],
};
const NO_SCRIPT: Script = { main: [], subagent: [] };
const planReady = (screen: string) => screen.includes("executor on 7") && screen.includes("UNPROVEN") && screen.includes("enter open");
const GUARD_SCRIPT: Script = {
  main: [{ content: [bash("rm -rf build", "Remove the build output")] }, { content: [text("The build is clean.")] }],
  subagent: [],
};
const guardReady = (screen: string) => /^● Removing/m.test(screen) && screen.includes("OMCA held this command");

// The board's split tier needs a docked pane body of 90 columns, which 200 columns leaves.
const CLIP_COLS = 200;
const CLIP_ROWS = 50;
// The before-and-after pairs fit the whole terminal in the video window, so Claude Code wraps every
// line inside the frame and none is cut. The larger font keeps a column dense, and the rows still
// fit the 2160-pixel screen.
const PAIR_COLS = 96;
const PAIR_ROWS = 34;
const PAIR_FONT = 35;
const has = (...parts: string[]) => (screen: string) => parts.every((part) => screen.includes(part));
// On the prompt row itself: the slash-command menu lists a command before it is fully typed.
const command = (line: string): Step[] => [
  { type: line },
  { until: (screen) => screen.split("\n").some((row) => /^❯\s/.test(row) && row.slice(2).trimEnd() === line), mark: "cmd-typed", hold: 0 },
  { key: "Enter" },
];
const RUN_GATES = { OMCA_DISABLED_HOOKS: "" };
// Bash mode: the prompt row starts with "!" instead of "❯".
const shell = (line: string): Step[] => [
  { type: "!" },
  { type: line },
  { until: (screen) => screen.split("\n").some((row) => /^!\s/.test(row) && row.slice(2).trimEnd() === line), mark: "shell-typed", hold: 0 },
  { key: "Enter" },
];
// Named, so plain Claude Code sends no title request for the mock to answer with a scripted turn.
const PLAIN = { plugin: false, args: ["--name", "acme-app"] } as const;
const BYPASS_ARGS = ["--permission-mode", "bypassPermissions"];
const BYPASS_SETTINGS = { skipDangerousModePermissionPrompt: true };
const WRAP_UP = "Wrap up the checkout work";
const CLEAN_UP = "Clean up the working tree";
// The project's uncommitted edits to the summary and payment steps are what a hard reset discards.
const resetScript = (after: string): Script => ({
  main: [{ content: [text("Resetting to the last commit."), bash("git reset --hard", "Discard the local changes")] }, { content: [text(after)] }],
  subagent: [],
});

const PLAN_PATH = "plans/saved-payment-methods.md";
const QUESTION = "Where should a saved card live?";
const savedCardsPlan = (status: "DRAFT" | "FINAL", body: string) => `# Add saved payment methods to checkout

**Scope**: about 8 files | **Parallel Execution**: YES - 2 waves | **Status**: ${status}

## Why
- Returning customers type their card on every order.

## TODOs
${body}
## Verification
- \`just ci\` exits 0.
`;
const DRAFT_PLAN = savedCardsPlan(
  "DRAFT",
  `
- [ ] 1. Store saved cards per customer
  - File: \`src/cart/saved-cards.ts\` (new)
- [ ] 2. Offer saving at the payment step
  - File: \`src/steps/payment.ts\`
- [ ] 3. List saved cards on the next order
  - File: \`src/steps/payment.ts\`, \`src/forms/card.ts\`

## Open questions
- Where a saved card lives. Default: a payment provider token, so no card data is stored here.
`,
);
const FINAL_PLAN = savedCardsPlan(
  "FINAL",
  `
- [ ] 1. Store provider tokens per customer
  - File: \`src/cart/saved-cards.ts\` (new)
  - Done when: \`bun test src/cart\` exits 0.
- [ ] 2. Offer saving at the payment step
  - File: \`src/steps/payment.ts\`
  - Done when: \`bun test src/steps\` exits 0.
- [ ] 3. List saved cards on the next order
  - File: \`src/steps/payment.ts\`, \`src/forms/card.ts\`
  - Done when: \`bun test src/steps\` exits 0.
- [ ] 4. Remove a card from the account and the vault
  - File: \`src/cart/saved-cards.ts\`
  - Done when: \`bun test src/cart\` exits 0.
- [ ] 5. Cover save, reuse and removal end to end
  - File: \`e2e/saved-cards.spec.ts\` (new)
  - Done when: \`just e2e\` exits 0.
`,
);

const EVIDENCE_LOG = "mcp__plugin_oh-my-claudeagent_omca__evidence_log";
const planSha256 = (project: string) => createHash("sha256").update(readFileSync(join(project, "plans", `${PLAN_NAME}.md`))).digest("hex");

const BOARD_STEPS: readonly Step[] = [
  { type: "Pick up the next task on the plan" },
  { key: "Enter" },
  { until: has("The executor is on task 7"), hold: 1_200 },
  ...command("/omca plan"),
  {
    until: (screen) => planReady(screen) && screen.includes("7. Wire the order summary panel"),
    mark: "board",
    targets: { "proven-chip": /(?<!UN)PROVEN/, "unproven-chip": /UNPROVEN/ },
  },
  { key: "Up" },
  { until: has("6. Build the payment step"), mark: "focus-moved", hold: 1_400 },
  { key: "Enter", gap: 0 },
  { until: has("b: Board"), mark: "task-open" },
];

export const CLIPS: readonly Clip[] = [
  {
    name: "clip-plain-stop",
    format: "clip",
    cols: PAIR_COLS,
    rows: PAIR_ROWS,
    font: PAIR_FONT,
    ...PLAIN,
    script: { main: [{ content: [text("All tasks are complete.")] }], subagent: [] },
    steps: [
      ...command(WRAP_UP),
      { until: has("All tasks are complete."), mark: "claim-done", hold: 1_500, targets: { "claim-line": /All tasks are complete\./ } },
      ...shell(`grep -F "[ ]" plans/${PLAN_NAME}.md`),
      { until: has("14. Remove the old checkout page"), mark: "open-tasks", targets: { "open-list": /- \[ \] 7\.[^\n]*(\n[^\n]*- \[ \] \d+\.[^\n]*)*/ } },
    ],
  },
  {
    name: "clip-plain-reset",
    format: "clip",
    cols: PAIR_COLS,
    rows: PAIR_ROWS,
    font: PAIR_FONT,
    plugin: false,
    args: [...PLAIN.args, ...BYPASS_ARGS],
    settings: BYPASS_SETTINGS,
    script: resetScript("The working tree is clean."),
    steps: [
      ...command(CLEAN_UP),
      {
        until: has("The working tree is clean."),
        mark: "reset-ran",
        targets: {
          "reset-call": /Bash\(git reset --hard\)\n[^\n]*HEAD is now at[^\n]*/,
          "lost-files": /Updated src\/steps\/payment\.ts[^\n]*(\n[^\n]*)*?\n[^\n]*Updated src\/steps\/summary\.ts[^\n]*/,
          "bypass-mode": /bypass permissions on/,
        },
      },
    ],
  },
  {
    name: "clip-refusal",
    format: "clip",
    cols: PAIR_COLS,
    rows: PAIR_ROWS,
    font: PAIR_FONT,
    env: RUN_GATES,
    script: {
      main: [
        { content: [text("All tasks are complete.")] },
        { content: [text("Task 7 is still open: the order summary panel is not wired yet. Starting on it now."), TASK_7] },
        { content: [text("The executor is on task 7.")] },
      ],
      subagent: [{ content: [tool("Read", { file_path: "src/steps/summary.ts" })] }, { content: [WATCH_SUMMARY] }],
    },
    steps: [
      ...command(WRAP_UP),
      { until: has("All tasks are complete."), mark: "claim-done", hold: 0, targets: { "claim-line": /All tasks are complete\./ } },
      { until: has("Stop hook feedback"), mark: "stop-feedback", targets: { "stop-line": /Stop hook feedback[^\n]*(\n {2,}\S[^\n]*)*/ } },
      { until: has("Task 7 is still open"), mark: "resumed" },
      { until: has("The executor is on task 7") },
    ],
  },
  {
    name: "clip-plan",
    format: "clip",
    cols: CLIP_COLS,
    rows: CLIP_ROWS,
    allow: ["Edit(plans/**)", "Skill(oh-my-claudeagent:analyzer *)", "Skill(oh-my-claudeagent:reviewer *)"],
    // The plan skill's protocol: a DRAFT plan first, the interview against it, the analyzer, the FINAL
    // rewrite, then the reviewer pass, analyzer and reviewer each a forked skill.
    script: (project) => ({
      main: [
        { content: [text("A draft first, so the interview has something concrete to correct."), tool("Write", { file_path: join(project, PLAN_PATH), content: DRAFT_PLAN })] },
        {
          content: [
            tool("AskUserQuestion", {
              questions: [
                {
                  question: QUESTION,
                  header: "Storage",
                  options: [
                    { label: "Our database", description: "Encrypt card details in the orders database." },
                    { label: "Provider vault", description: "Keep only a token from the payment provider." },
                    { label: "Nowhere", description: "Prefill the card form from the last order instead." },
                  ],
                  multiSelect: false,
                },
              ],
            }),
          ],
        },
        { content: [text("Provider tokens, then. The analyzer checks the draft for gaps."), tool("Skill", { skill: "oh-my-claudeagent:analyzer", args: PLAN_PATH })] },
        { content: [tool("Write", { file_path: join(project, PLAN_PATH), content: FINAL_PLAN })] },
        { content: [tool("Skill", { skill: "oh-my-claudeagent:reviewer", args: PLAN_PATH })] },
        { content: [text("The reviewer says OKAY: 5 tasks in 2 waves. Run /oh-my-claudeagent:start-work to begin.")] },
      ],
      subagent: [
        { content: [text("One gap: removing a card must also delete its token from the vault. Add it as its own task, with an end-to-end check.")] },
        { content: [text("OKAY. Every task names its files and the command that proves it.")] },
      ],
    }),
    steps: [
      ...command("/oh-my-claudeagent:plan Add saved payment methods to checkout"),
      { until: has(QUESTION, "Provider vault"), mark: "dialog", targets: { question: /Where should a saved card live\?/ } },
      { key: "Down" },
      { until: (screen) => /❯[^\n]*Provider vault/.test(screen), mark: "key-choice", hold: 0 },
      { key: "Enter" },
      // Claude Code draws a write into plansDirectory as "Updated plan"; the second is the FINAL rewrite.
      { until: (screen) => screen.split("● Updated plan").length > 2, mark: "plan-written" },
      { until: has("The reviewer says OKAY") },
    ],
  },
  {
    name: "clip-delegate",
    format: "clip",
    cols: CLIP_COLS,
    rows: CLIP_ROWS,
    script: {
      main: [
        {
          content: [
            text("Tasks 7, 9 and 11 have their dependencies met. One executor each."),
            TASK_7,
            executor("Persist the draft order", "Task 9: save the draft order on every step so a reload keeps it."),
            executor("Add the checkout feature flag", "Task 11: serve the new checkout to staff first, then to a share of customers."),
          ],
        },
        { content: [text("Three executors are running, on tasks 7, 9 and 11.")] },
      ],
      subagent: [
        { content: [tool("Read", { file_path: "src/steps/summary.ts" })] },
        { content: [tool("Read", { file_path: "src/cart/totals.ts" })] },
        { content: [tool("Glob", { pattern: "src/**/*.ts" })] },
        { content: [WATCH_SUMMARY] },
        { content: [bash("just watch draft", "Run the draft order tests in watch mode")] },
        { content: [bash("just watch flags", "Run the feature flag tests in watch mode")] },
      ],
    },
    steps: [
      ...command("/oh-my-claudeagent:start-work"),
      { until: has("Three executors are running"), mark: "spawned" },
      { type: "/omca" },
      { key: "Enter" },
      { until: has("1: Agents"), mark: "pane", hold: 0 },
      { until: has("just watch summary", "just watch draft", "just watch flags"), mark: "lanes", hold: 6_000, targets: { "tool-row": /\S Bash just watch \w+/, "lane-head": /executor {2,}\S+ running +\d+s/ } },
    ],
  },
  { name: "clip-board", format: "clip", cols: CLIP_COLS, rows: CLIP_ROWS, script: PLAN_SCRIPT, steps: BOARD_STEPS },
  {
    name: "clip-guard",
    format: "clip",
    cols: PAIR_COLS,
    rows: PAIR_ROWS,
    font: PAIR_FONT,
    args: BYPASS_ARGS,
    settings: BYPASS_SETTINGS,
    script: resetScript("Understood. Your changes stay as they are."),
    steps: [
      ...command(CLEAN_UP),
      { until: has("OMCA held this command", "Run it?"), mark: "dialog", hold: 3_000, targets: { "discard-lines": /git reset --hard discards[^\n]*(\n[^\n]*\|[^\n]*)*/ } },
      { key: "Enter", gap: 0 },
      { until: has("Your changes stay as they are."), mark: "refused" },
    ],
  },
  {
    name: "clip-verify",
    format: "clip",
    cols: CLIP_COLS,
    rows: CLIP_ROWS,
    fixture: "acme-app-verified",
    env: RUN_GATES,
    allow: [EVIDENCE_LOG],
    script: (project) => ({
      main: [
        { content: [text("All 14 tasks are checked. Running the suite for the final verification."), bash("just test", "Run the test suite")] },
        {
          content: [
            text("The suite passes. Recording the verdict against the plan."),
            tool(EVIDENCE_LOG, {
              evidence_type: "final_verification",
              command: "just test",
              exit_code: 0,
              output_snippet: "14 of 14 tasks checked; 42 tests passed",
              verified_by: "orchestrator",
              plan_sha256: planSha256(project),
            }),
          ],
        },
        { content: [text("The verdict is logged and matches the plan as it is now.")] },
      ],
      subagent: [],
    }),
    // The pane opens on the Evidence tab first, so the verdict turns COMPLETE on screen.
    steps: [
      { type: "/omca" },
      { key: "Enter" },
      { until: has("1: Agents"), hold: 0 },
      { key: "3" },
      { until: has("MISSING"), hold: 1_200 },
      { key: "C-x" },
      { key: "Tab", gap: 300 },
      ...command("Run the final verification"),
      // Claude Code collapses a finished call to one line, so the marks wait for those lines.
      { until: has("Ran 1 shell command", "The suite passes"), mark: "tests-pass", hold: 0 },
      { until: has("Called plugin:oh-my-claudeagent:omca"), mark: "evidence-logged", hold: 0 },
      {
        until: (screen) => /COMPLETE\s+matches/.test(screen),
        mark: "complete",
        targets: { "complete-chip": /COMPLETE(?=\s+matches)/, "verdict-line": /COMPLETE\s+matches the current plan · \d\d-\d\d \d\d:\d\d/ },
      },
      // The drift guard and the final-verification gate both let this stop through.
      { until: (screen) => !screen.includes("Stop hook"), hold: 1_200 },
    ],
  },
  { name: "clip-board-light", format: "clip", cols: CLIP_COLS, rows: CLIP_ROWS, theme: "light", script: PLAN_SCRIPT, steps: BOARD_STEPS },
  {
    // The pane's tabs while an executor works, on a project with notes and delegation history,
    // ending on a rating of the turn.
    name: "clip-tour",
    format: "clip",
    cols: CLIP_COLS,
    rows: CLIP_ROWS,
    fixture: "acme-app-tour",
    script: PLAN_SCRIPT,
    steps: [
      { type: "Pick up the next task on the plan" },
      { key: "Enter" },
      {
        until: has("The executor is on task 7"),
        hold: 1_200,
        targets: { band: /\d+\/\d+ · next [^\n│[]*[^\s│[]/, "cost-row": /\$\d+\.\d\d · / },
      },
      ...command("/omca"),
      { until: has("1: Agents", "Wire the order summary panel"), mark: "agents-tab" },
      { key: "2", gap: 0 },
      { until: has("Ship the checkout redesign", "PROVEN"), mark: "plan-tab" },
      { key: "3", gap: 0 },
      { until: has("Final verification"), mark: "evidence-tab" },
      { key: "4", gap: 0 },
      { until: has("Learnings · "), mark: "notepad-tab", targets: { "notepad-card": /╭─+╮(?=[^\n]*\n[^\n]*Learnings · \d+ entr)/ } },
      { key: "6", gap: 0 },
      { until: has("delegations in"), mark: "stats-tab", targets: { "stats-header": /agent +runs +median +tokens[^\n│]*outcomes/ } },
      { key: "5", gap: 0 },
      { until: has("rate the last turn"), mark: "feedback-tab", hold: 1_200 },
      { key: "u", gap: 0 },
      { until: has("1 rating"), mark: "rated" },
    ],
  },
];

export const SHOTS: readonly Still[] = [
  {
    name: "hero",
    format: "png",
    cols: 200,
    rows: 50,
    command: "Pick up the next task on the plan",
    keys: ["/omca plan", "Enter"],
    script: PLAN_SCRIPT,
    ready: (screen) => planReady(screen) && screen.includes("7. Wire the order summary panel"),
  },
  {
    name: "band",
    format: "png",
    cols: 120,
    rows: 30,
    command: "Run the tests",
    keys: [],
    script: {
      main: [{ content: [bash("just test", "Run the tests"), TASK_7] }, { content: [text("The tests pass, and the executor is on task 7.")] }],
      subagent: [{ content: [tool("Read", { file_path: "src/steps/summary.ts" })] }, { content: [WATCH_SUMMARY] }],
    },
    ready: (screen) => screen.includes("evidence not logged") && screen.includes("1 running"),
  },
  {
    name: "plan",
    format: "png",
    cols: 214,
    rows: 44,
    command: "Pick up the next task on the plan",
    keys: ["/omca plan", "Enter", "Up"],
    script: PLAN_SCRIPT,
    ready: (screen) => planReady(screen) && screen.includes("6. Build the payment step"),
    crop: "pane",
  },
  {
    name: "evidence",
    format: "png",
    cols: 214,
    rows: 32,
    command: "/omca",
    keys: ["3"],
    script: NO_SCRIPT,
    ready: (screen) => screen.includes("MISSING") && screen.includes("‹masked›"),
    crop: "pane",
  },
  {
    name: "agents",
    format: "png",
    cols: 214,
    rows: 22,
    command: "Start the open checkout tasks",
    keys: ["/omca", "Enter"],
    // Subagents share one queue of scripted turns, so explore finishes and the first executor
    // reaches its watch before the second starts, which fixes which agent draws which turn.
    script: {
      main: [
        {
          content: [
            text("Task 8 needs the current error messages first; explore will map them."),
            agent("explorer", "Map the validation messages", "Task 8: list every validation message the address and card forms build today."),
          ],
        },
        { content: [text("The explorer is mapping the messages.")] },
        { content: [text("The explorer mapped the messages. Tasks 7 and 9 can start now."), TASK_7] },
        { content: [bash("sleep 3", "Let the first executor settle")] },
        { content: [executor("Persist the draft order", "Task 9: save the draft order on every step so a reload keeps it.")] },
        { content: [text("Two executors are running, on tasks 7 and 9.")] },
      ],
      subagent: [
        { content: [tool("Grep", { pattern: "error", path: "src/forms" })] },
        { content: [tool("Read", { file_path: "src/forms/card.ts" })] },
        { content: [text("The forms build seven messages: four in src/forms/address.ts and three in src/forms/card.ts.")] },
        { content: [tool("Read", { file_path: "src/steps/summary.ts" })] },
        { content: [tool("Grep", { pattern: "total", path: "src/cart" })] },
        { content: [WATCH_SUMMARY] },
        { content: [tool("Read", { file_path: "src/cart/totals.ts" })] },
        { content: [tool("Glob", { pattern: "src/cart/*.ts" })] },
        { content: [bash("just watch draft", "Run the draft order tests in watch mode")] },
      ],
    },
    ready: (screen) => screen.includes("just watch summary") && screen.includes("just watch draft") && screen.includes("explorer · The forms build"),
    crop: "pane",
  },
  {
    name: "mascots",
    format: "png",
    cols: 200,
    rows: 36,
    command: "Start the open checkout tasks",
    keys: ["/omca", "Enter"],
    // Each subagent takes the next scripted turn, so the sleeps keep all three running while the
    // pane draws their lanes, each led by its mini.
    script: {
      main: [
        { content: [text("Three agents can start now."), TASK_7] },
        { content: [bash("sleep 3", "Let the executor settle")] },
        { content: [agent("explorer", "Map the validation messages", "Task 8: list every validation message the forms build today.")] },
        { content: [bash("sleep 3", "Let the explorer settle")] },
        { content: [agent("architect", "Review the checkout flow", "Review how the draft order and the summary panel share state.")] },
        { content: [text("The executor, the explorer and the architect are running.")] },
      ],
      subagent: [
        { content: [bash("sleep 600", "Hold the executor open")] },
        { content: [bash("sleep 600", "Hold the explorer open")] },
        { content: [bash("sleep 600", "Hold the architect open")] },
      ],
    },
    ready: (screen) => ["executor", "explorer", "architect"].every((name) => new RegExp(`${name} {2,}\\S+ running`).test(screen)),
    crop: "pane",
  },
  { name: "guard", format: "png", cols: 120, rows: 26, command: "Clean the build", keys: [], script: GUARD_SCRIPT, ready: guardReady },
  {
    name: "doctor",
    format: "png",
    cols: 214,
    rows: 26,
    command: "Say hello",
    keys: ["/omca doctor", "Enter"],
    script: { main: [{ content: [text("Hello.")] }], subagent: [] },
    ready: (screen) => screen.includes("checked") && screen.includes("WARN"),
    crop: "pane",
    // An effort cap below architect's declared xhigh is a real WARN the doctor explains.
    settings: { maxEffortLevel: "high" },
  },
  {
    name: "statusline",
    format: "png",
    cols: 160,
    rows: 34,
    command: "Run the type and lint checks in parallel",
    keys: [],
    script: {
      main: [
        {
          content: [
            text("I will run both checks at once."),
            executor("Check the types", "Run the type checker."),
            executor("Check the lint rules", "Run the linter."),
          ],
        },
        { content: [text("Both checks are running.")] },
      ],
      subagent: [
        { content: [bash("sleep 25", "Run the type checker")] },
        { content: [bash("sleep 25", "Run the linter")] },
        { content: [text("The type check passed.")] },
        { content: [text("The lint check passed.")] },
      ],
    },
    ready: (screen) => screen.includes("Check the lint rules · "),
  },
  {
    name: "pane-tour",
    format: "gif",
    cols: 160,
    rows: 42,
    command: "Pick up the next task on the plan",
    keys: ["/omca plan", "Enter", "Down", "Enter", "1", "3", "2"],
    script: PLAN_SCRIPT,
    ready: (screen) => screen.includes("8. Add inline validation errors") && screen.includes("b: Board"),
  },
  { name: "guard-dialog", format: "gif", cols: 120, rows: 26, command: "Clean the build", keys: [], script: GUARD_SCRIPT, ready: guardReady },
];

function run(argv: readonly string[], env: Record<string, string>, timeout = RUN_TIMEOUT_MS): string {
  const { exitCode, stdout, stderr } = Bun.spawnSync([...argv], { env, stdout: "pipe", stderr: "pipe", timeout });
  if (exitCode !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ""} exited ${exitCode}: ${stderr.toString().trim()}`);
  return stdout.toString();
}

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = WINDOW_TIMEOUT_MS, pollMs = POLL_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(pollMs);
  }
}

function git(cwd: string, home: string, ...args: string[]): void {
  run(["git", "-C", cwd, ...args], { ...sessionEnv(), HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const EXECUTOR = "oh-my-claudeagent:executor";
const ORCHESTRATOR = "oh-my-claudeagent:orchestrator";
const BUILD_FIXER = "oh-my-claudeagent:build-fixer";

// Each run's age before the capture, so the day groups and the times beside them read as recent
// whenever the script runs. The newest test passed after every task file but task 7's changed,
// which makes tasks 1 to 6 PROVEN and task 7 UNPROVEN.
const LEDGER: readonly (readonly [age: number, type: string, command: string, exitCode: number, snippet: string, by: string])[] = [
  [50 * HOUR, "build", "bun run build", 0, "built 38 modules in 1.1 s", EXECUTOR],
  [49.5 * HOUR, "test", "bun test src/cart", 1, "(fail) tax on a discounted line\n  Expected: 263\n  Received: 315\n 11 pass\n 1 fail", EXECUTOR],
  [49 * HOUR, "test", "bun test src/cart", 0, " 12 pass\n 0 fail\nRan 12 tests across 2 files. [41.00ms]", EXECUTOR],
  [47 * HOUR, "lint", "just lint", 0, "Found 0 warnings and 0 errors.", EXECUTOR],
  [27 * HOUR, "test", "bun test src/forms", 0, " 21 pass\n 0 fail\nRan 21 tests across 2 files. [38.00ms]", EXECUTOR],
  [25.5 * HOUR, "lint", "just typecheck", 1, "src/steps/address.ts:4:3 - error TS2322: Type 'string' is not assignable to type 'boolean'.", BUILD_FIXER],
  [25 * HOUR, "lint", "just typecheck", 0, "tsc --noEmit: no errors", BUILD_FIXER],
  [24.5 * HOUR, "build", "bun run build", 0, "built 41 modules in 1.2 s", EXECUTOR],
  [23 * HOUR, "final_verification", "just ci", 1, "INCOMPLETE: 9 of 14 tasks are open\nlint, typecheck and test pass; the e2e suite is not written yet", ORCHESTRATOR],
  [170 * MINUTE, "test", "bun test src/steps", 1, "(fail) a declined card keeps the cart\n  Expected: 3 items\n  Received: 0 items\n 17 pass\n 1 fail", EXECUTOR],
  [140 * MINUTE, "test", "bun test src/steps", 0, " 18 pass\n 0 fail\nRan 18 tests across 3 files. [212.00ms]", EXECUTOR],
  [100 * MINUTE, "lint", "just lint", 0, "Found 0 warnings and 0 errors.", EXECUTOR],
  [45 * MINUTE, "test", "bun test", 0, " 142 pass\n 0 fail\nRan 142 tests across 14 files. [1.84s]", EXECUTOR],
  [
    20 * MINUTE,
    "manual",
    'PAYMENTS_API_KEY="fake-sandbox-key" bun run smoke:payment',
    0,
    "card ending 0002 declined: cart kept, 3 items\ncard ending 4242 accepted: draft order saved\nsmoke passed in 2.8 s",
    ORCHESTRATOR,
  ],
];

const FILE_AGES: readonly (readonly [age: number, files: readonly string[]])[] = [
  [51 * HOUR, ["src/cart/totals.ts", "src/cart/tax.ts", "config/tax.json"]],
  [28 * HOUR, ["src/forms/address.ts", "src/forms/card.ts"]],
  [26 * HOUR, ["src/steps/address.ts"]],
  [3 * HOUR, ["src/steps/payment.ts"]],
  [6 * MINUTE, ["src/steps/summary.ts", "src/steps/summary.spec.ts"]],
];

function writeProject(project: string, home: string, shot: Shot): void {
  cpSync(FIXTURE, project, { recursive: true });
  if (shot.fixture !== undefined) cpSync(join(FIXTURE, "..", shot.fixture), project, { recursive: true });
  const plan = join(project, "plans", `${PLAN_NAME}.md`);
  mkdirSync(join(project, ".claude"), { recursive: true });
  mkdirSync(join(project, ".omca", "state"), { recursive: true });
  mkdirSync(join(project, ".omca", "evidence"), { recursive: true });
  writeFileSync(
    join(project, ".claude", "settings.json"),
    JSON.stringify({
      plansDirectory: join(project, "plans"),
      permissions: { defaultMode: "default", allow: ["Bash(just test)", "Bash(just watch *)", "Bash(sleep *)", ...(shot.allow ?? [])] },
    }),
  );
  writeFileSync(
    join(project, ".omca", "state", "boulder.json"),
    JSON.stringify({
      plans: { [PLAN_NAME]: { active_plan: plan, started_at: "2026-10-02T08:00:00Z", session_ids: [SESSION_ID] } },
      bindings: { [SESSION_ID]: { plan_name: PLAN_NAME, bound_at: 1790928000 } },
    }),
  );
  writeFileSync(join(project, ".gitignore"), ".omca/\n.claude/\n");
  git(project, home, "init", "-q", "-b", "main");
  git(project, home, "config", "user.name", "Acme Dev");
  git(project, home, "config", "user.email", "dev@example.invalid");
  git(project, home, "add", "-A");
  git(project, home, "commit", "-q", "-m", "Initial commit");
  writeFileSync(join(project, "src", "steps", "summary.ts"), 'import { total } from "../cart/totals.ts";\n\nexport const summaryPanel = { title: "Order summary", total };\n');
  writeFileSync(join(project, "src", "steps", "payment.ts"), 'export const paymentStep = (declined?: string) => ({ title: "Payment", keepCart: true, alert: declined ?? "" });\n');
  writeFileSync(join(project, "src", "steps", "summary.spec.ts"), 'import { expect, test } from "bun:test";\n\ntest.todo("lists items, tax and shipping");\n');
  git(project, home, "add", "src/steps/summary.spec.ts");

  const now = Date.now();
  const entries = LEDGER.map(([age, type, command, exitCode, snippet, by]) => ({
    type,
    command,
    exit_code: exitCode,
    output_snippet: snippet,
    timestamp: new Date(now - age).toISOString(),
    verified_by: by,
  }));
  const ledger = join(project, ".omca", "evidence", "verification-evidence.json");
  writeFileSync(ledger, JSON.stringify({ entries }, null, 2));
  // The band counts a ledger changed within seconds of a verification as its evidence.
  const lastLogged = new Date(now - Math.min(...LEDGER.map(([age]) => age)));
  utimesSync(ledger, lastLogged, lastLogged);
  for (const [age, files] of FILE_AGES) {
    const at = new Date(now - age);
    for (const file of files) utimesSync(join(project, file), at, at);
  }
}

function findFont(env: Record<string, string>): { family: string; dir: string } {
  for (const family of FONT_FAMILIES) {
    const file = run(["fc-list", "-f", "%{file}\n", `:family=${family}:style=Regular`], env).split("\n")[0];
    if (file) return { family, dir: dirname(file) };
  }
  throw new Error(`no terminal font found; install one of: ${FONT_FAMILIES.join(", ")}`);
}

// A fontconfig file that sees the system fonts and the chosen font's directory, so kitty runs
// with a scratch HOME and never reads the maintainer's own font or terminal configuration.
function fontConfig(fontDir: string, cacheDir: string): string {
  return `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${fontDir}</dir><cachedir>${cacheDir}</cachedir></fontconfig>\n`;
}

// A private display numbered well above the ones a desktop session takes.
function freeDisplay(): string {
  for (let number = FIRST_DISPLAY; number < FIRST_DISPLAY + 100; number += 1) {
    if (!existsSync(`/tmp/.X${number}-lock`) && !existsSync(`/tmp/.X11-unix/X${number}`)) return `:${number}`;
  }
  throw new Error("no free X display number");
}

function offDesktop(env: Record<string, string>, display: string): Record<string, string> {
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, WAYLAND_SOCKET: _socket, ...rest } = env;
  return { ...rest, DISPLAY: display };
}

async function stop(child: Subprocess): Promise<void> {
  child.kill();
  await child.exited;
}

type Window = { x: number; y: number; width: number; height: number };

function windowOf(env: Record<string, string>): Window | undefined {
  const id = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--class", KITTY_CLASS], { env, stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n")[0];
  if (!id) return undefined;
  const geometry = Object.fromEntries(
    run(["xdotool", "getwindowgeometry", "--shell", id], env)
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  const width = Number(geometry["WIDTH"]);
  return width > 1 ? { x: Number(geometry["X"]), y: Number(geometry["Y"]), width, height: Number(geometry["HEIGHT"]) } : undefined;
}

// The docked pane begins at the border column its tab row opens with and ends at the first row
// without that border. tmux prints one character per cell here, since the rows hold no wide glyphs.
function paneArea(screen: string, window: Window, shot: Still): Window {
  const rows = screen.split("\n").map((row) => [...row]);
  const column = rows[0]?.indexOf("│") ?? -1;
  if (column < 0) throw new Error(`${shot.name}: the screen shows no docked pane to crop to`);
  const end = rows.findIndex((row) => row[column] !== "│");
  // kitty draws whole cells from the top-left padding and leaves any spare pixels at the bottom
  // and right, so the window size divided by the grid overstates a cell.
  const cellWidth = Math.floor((window.width - 2 * PADDING_PX) / shot.cols);
  const cellHeight = Math.floor((window.height - 2 * PADDING_PX) / shot.rows);
  // From the middle of the border cell, where kitty draws the line, so no transcript glyph that
  // overflows its cell shows; to the right padding, so the close mark in the last cell stays whole.
  const left = PADDING_PX + column * cellWidth + Math.floor(cellWidth / 2) - 1;
  return {
    x: window.x + left,
    y: window.y + PADDING_PX,
    width: 2 * PADDING_PX + shot.cols * cellWidth - left,
    height: end * cellHeight,
  };
}

function clientSize(tmux: Tmux): string | undefined {
  return tmux.run(["list-clients", "-F", "#{client_width}x#{client_height}"]).trim().split("\n")[0] || undefined;
}

type Recording = { ffmpeg: Subprocess; stopWatch: () => void; finish: () => Promise<string> };

// Records the area losslessly while the screen text is checked for private values, since a
// frame that showed one cannot be masked afterwards. finish() returns ffmpeg's log.
function record(area: Window, fps: number, raw: string, display: string, env: Record<string, string>, check: () => void): Recording {
  const ffmpeg = Bun.spawn(
    [
      "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info", "-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps),
      "-video_size", `${area.width}x${area.height}`, "-i", `${display}+${area.x},${area.y}`,
      "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", raw,
    ],
    { env, stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  const log = new Response(ffmpeg.stderr).text();
  let leak: unknown;
  const watch = setInterval(() => {
    try {
      check();
    } catch (error) {
      leak ??= error;
    }
  }, POLL_MS);
  return {
    ffmpeg,
    stopWatch: () => clearInterval(watch),
    async finish() {
      clearInterval(watch);
      ffmpeg.stdin.write("q");
      await ffmpeg.stdin.end();
      const code = await ffmpeg.exited;
      const text = await log;
      if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${text.trim()}`);
      if (leak !== undefined) throw leak;
      return text;
    },
  };
}

function toGif(raw: string, out: string, env: Record<string, string>): void {
  const palette = `fps=${GIF_FPS},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
  run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-vf", palette, "-loop", "0", out], env);
}

function delayed(port: number | undefined, delayMs: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const reply = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body: await req.text() });
      const body = await reply.arrayBuffer();
      await Bun.sleep(delayMs);
      return new Response(body, { status: reply.status, headers: reply.headers });
    },
  });
}

export type Span = { row: number; col: number; len: number; rows: number };

// The cell span a match covers, counting one cell per code point; a match over several rows spans
// from its leftmost text, skipping the indent and any dialog gutter of each continued row.
export function locate(screen: string, pattern: RegExp): Span | undefined {
  const match = pattern.exec(screen);
  if (match === null) return undefined;
  const above = screen.slice(0, match.index).split("\n");
  const lines = match[0].split("\n").map((line, index) => {
    const cells = [...line.trimEnd()].length;
    const start = index === 0 ? [...(above.at(-1) ?? "")].length : cells - [...line.trim().replace(/^│\s*/, "")].length;
    return { start, end: index === 0 ? start + cells : cells };
  });
  const col = Math.min(...lines.map((line) => line.start));
  return { row: above.length - 1, col, len: Math.max(...lines.map((line) => line.end)) - col, rows: lines.length };
}

type Followed = { pattern: RegExp; span: Span; from: number; last: number; isMoved: boolean };
// Wall-clock milliseconds, each already past the paint that showed it.
type Played = { marks: Record<string, number>; targets: Record<string, Followed> };
type Seen = { at: number; screen: string };

async function playClip(shot: Clip, tmux: Tmux): Promise<Played> {
  const played: Played = { marks: {}, targets: {} };
  // Every polled screen, so a state that arrived while an earlier step held is dated when it came.
  const history: Seen[] = [];
  let since = Date.now();
  const follow = setInterval(() => {
    const screen = tmux.screen();
    history.push({ at: Date.now(), screen });
    const shownAt = Date.now() + CLIP_PAINT_MS;
    for (const target of Object.values(played.targets)) {
      if (target.isMoved) continue;
      const span = locate(screen, target.pattern);
      if (span?.row === target.span.row && span.col === target.span.col) target.last = shownAt;
      else target.isMoved = true;
    }
  }, CLIP_POLL_MS);
  try {
    await Bun.sleep(CLIP_KEY_GAP_MS);
    for (const step of shot.steps) {
      if ("type" in step) {
        since = Date.now();
        for (const char of step.type) {
          tmux.send("-l", char);
          await Bun.sleep(TYPE_MS);
        }
      } else if ("key" in step) {
        await Bun.sleep(step.gap ?? CLIP_KEY_GAP_MS);
        since = Date.now();
        tmux.send(step.key);
      } else {
        const polled = await until(
          () => {
            const current = tmux.screen();
            if (current.includes("did not load")) throw new Error(`${shot.name}: the plugin snapshot did not load`);
            return step.until(current) ? current : undefined;
          },
          `${shot.name} to reach ${step.mark ?? "its next state"}`,
          READY_TIMEOUT_MS,
          CLIP_POLL_MS,
        ).catch((error: unknown) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; the screen was:\n${tmux.screen()}`);
        });
        const first = history.find((seen) => seen.at >= since && step.until(seen.screen)) ?? { at: Date.now(), screen: polled };
        const { screen } = first;
        since = first.at;
        const shownAt = first.at + CLIP_PAINT_MS;
        if (step.mark !== undefined) played.marks[step.mark] = shownAt;
        for (const [name, pattern] of Object.entries(step.targets ?? {})) {
          const span = locate(screen, pattern);
          if (span === undefined) throw new Error(`${shot.name}: no ${name} target (${pattern}) on the screen:\n${screen}`);
          played.targets[name] = { pattern, span, from: shownAt, last: shownAt, isMoved: false };
        }
        await Bun.sleep(step.hold ?? HOLD_MS);
      }
    }
    return played;
  } finally {
    clearInterval(follow);
  }
}

type Finish = { raw: string; log: string; played: Played; window: Window; outDir: string; scratch: string; env: Record<string, string> };

// x11grab stamps each frame with the wall clock, so an event's frame is its wall-clock time less
// the first frame's.
function finishClip(shot: Clip, { raw, log, played, window, outDir, scratch, env }: Finish): string {
  const start = /^\s*Duration: N\/A, start: (\d+\.\d+)/m.exec(log)?.[1];
  if (start === undefined) throw new Error(`${shot.name}: ffmpeg did not report the first frame's time:\n${log}`);
  const out = join(outDir, `${shot.name}.mp4`);
  run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, ...CLIP_ENCODE, out], env, TRANSCODE_TIMEOUT_MS);
  const [width, height, frames] = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", out], env)
    .trim()
    .split(",")
    .map(Number);
  if (width === undefined || height === undefined || frames === undefined || !(frames > 0)) throw new Error(`${shot.name}: ffprobe found no video frames in ${out}`);
  const frame = (at: number) => Math.min(frames - 1, Math.max(0, Math.round((at / 1000 - Number(start)) * CLIP_FPS)));
  const manifest: ClipManifest = {
    scene: shot.name,
    fps: CLIP_FPS,
    width,
    height,
    frames,
    grid: { cols: shot.cols, rows: shot.rows },
    cell: { width: Math.floor((window.width - 2 * PADDING_PX) / shot.cols), height: Math.floor((window.height - 2 * PADDING_PX) / shot.rows) },
    origin: { x: PADDING_PX, y: PADDING_PX },
    marks: Object.fromEntries(Object.entries(played.marks).map(([mark, at]) => [mark, frame(at)])),
    targets: Object.fromEntries(Object.entries(played.targets).map(([name, { span, from, last }]) => [name, { ...span, from: frame(from), to: frame(last) }])),
  };
  writeFileSync(join(outDir, `${shot.name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

  const tiles = Object.entries(manifest.marks).flatMap(([mark, at]) => {
    const tile = join(scratch, `${mark}.png`);
    run(["ffmpeg", "-loglevel", "error", "-y", "-ss", String(at / CLIP_FPS), "-i", out, "-frames:v", "1", tile], env);
    return ["-label", `${mark} · frame ${at}`, tile];
  });
  run(
    ["magick", "montage", "-pointsize", "40", "-fill", "#f4f4f5", "-background", "#18181b", ...tiles, "-tile", "2x", "-geometry", "1600x+16+16", join(outDir, `${shot.name}.sheet.png`)],
    env,
  );
  return out;
}

async function captureShot(shot: Shot, outDir: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const home = join(scratch, "home");
  const project = join(home, "acme-app");
  const config = join(home, ".claude");
  const plugin = join(home, "oh-my-claudeagent");
  const forbidden = machineValues(scratch);
  const env = sessionEnv();
  let mock: ReturnType<typeof startServer> | undefined;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  const tmux = new Tmux(SOCKET, ["-f", "/dev/null"]);
  const children: Subprocess[] = [];
  let claudePid: number | undefined;
  let recording: Recording | undefined;
  const stopAll = () =>
    teardown(
      () => recording?.stopWatch(),
      () => Bun.spawnSync(["tmux", "-L", SOCKET, "-f", "/dev/null", "kill-server"], { env }),
      () => claudePid !== undefined && exited(claudePid),
      ...[...children].reverse().map((child) => () => stop(child)),
      () => proxy?.stop(true),
      () => mock?.stop(true),
      () => rmSync(scratch, { recursive: true, force: true }),
    );
  const release = cleanupOnSignal(stopAll);
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(config);
    mkdirSync(join(scratch, "tmp"));
    writeProject(project, home, shot);
    mock = startServer({ port: 0, script: typeof shot.script === "function" ? shot.script(project) : shot.script });
    if (shot.format === "clip") proxy = delayed(mock.port, CLIP_MODEL_MS);
    const withPlugin = shot.plugin !== false;
    if (withPlugin) packageTree(REPO, plugin);
    const bun = Bun.which("bun") ?? "bun";
    const statusline = (entry: string) => `${quote(bun)} ${quote(join(plugin, "statusline", entry))}`;
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: shot.theme ?? "dark" }));
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({
        tui: "fullscreen",
        prefersReducedMotion: true,
        ...(withPlugin && {
          statusLine: { type: "command", command: statusline("main.ts"), padding: 1, refreshInterval: 5, hideVimModeIndicator: true },
          subagentStatusLine: { type: "command", command: statusline("subagent.ts") },
        }),
        ...shot.settings,
      }),
    );

    const font = findFont(env);
    const display = freeDisplay();
    const screenEnv = offDesktop(env, display);
    const xvfb = Bun.spawn(["Xvfb", display, "-displayfd", "1", "-screen", "0", SCREEN, "-dpi", String(DPI), "-nolisten", "tcp"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(xvfb);
    const { value: ready } = await xvfb.stdout.getReader().read();
    if (ready === undefined) throw new Error(`Xvfb did not start on ${display}: ${(await new Response(xvfb.stderr).text()).trim()}`);

    tmux.run([
      ...TERMINAL_OPTIONS,
      "new-session", "-d", "-s", tmux.target, "-x", String(shot.cols), "-y", String(shot.rows), "-c", project,
      "-e", `HOME=${home}`,
      "-e", `CLAUDE_CONFIG_DIR=${config}`,
      "-e", `TMPDIR=${join(scratch, "tmp")}`,
      ...mockSessionEnv((proxy ?? mock).port),
      ...TRUECOLOR_ENV,
      ...Object.entries({ OMCA_DISABLED_HOOKS: "stop-gates", ...shot.env }).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      ["claude", ...(withPlugin ? ["--plugin-dir", quote(plugin)] : []), "--session-id", SESSION_ID, ...(shot.args ?? [])].join(" "),
      // kitty's attached client would otherwise take a row for the tmux status bar, and Claude Code
      // shows a hint row when tmux has mouse events off.
      ";", "set-option", "-g", "status", "off",
      ";", "set-option", "-g", "mouse", "on",
    ]);
    claudePid = Number(tmux.run(["display-message", "-p", "-t", tmux.target, "#{pane_pid}"]).trim());

    const kittyDir = join(scratch, "kitty");
    mkdirSync(kittyDir);
    writeFileSync(join(kittyDir, "fonts.conf"), fontConfig(font.dir, join(kittyDir, "fontconfig")));
    const kitty = Bun.spawn(
      [
        "kitty", "--config", "NONE", "--class", KITTY_CLASS,
        "-o", `font_family=${font.family}`,
        "-o", `font_size=${shot.format === "clip" ? (shot.font ?? CLIP_FONT_SIZE) : FONT_SIZE}`,
        "-o", `initial_window_width=${shot.cols}c`,
        "-o", `initial_window_height=${shot.rows}c`,
        "-o", "remember_window_size=no",
        "-o", `window_padding_width=${PADDING}`,
        "-o", "cursor_blink_interval=0",
        "-o", "linux_display_server=x11",
        // kitty widens a symbol the font lacks over the space after it, which ran the last cell of
        // each progress bar into the count beside it.
        "-o", "narrow_symbols=U+25A0-U+25FF 1",
        ...(shot.theme === "light" ? LIGHT_TERMINAL : []),
        "tmux", "-L", SOCKET, "-f", "/dev/null", "attach-session", "-t", tmux.target,
      ],
      {
        env: { ...screenEnv, HOME: kittyDir, XDG_CONFIG_HOME: join(kittyDir, "config"), XDG_CACHE_HOME: join(kittyDir, "cache"), FONTCONFIG_FILE: join(kittyDir, "fonts.conf") },
        stdout: "ignore",
        stderr: Bun.file(join(kittyDir, "kitty.log")),
      },
    );
    children.push(kitty);
    const window = await until(() => windowOf(screenEnv), `the kitty window on ${display} (log: ${join(kittyDir, "kitty.log")})`);
    const size = await until(() => clientSize(tmux), "kitty to attach to the tmux session");
    if (size !== `${shot.cols}x${shot.rows}`) throw new Error(`${shot.name}: kitty opened a ${size} grid, not ${shot.cols}x${shot.rows}`);

    await reachPrompt(tmux);
    const isPrivate = () => assertPrivate(tmux.screen(), forbidden);
    if (shot.format === "clip") {
      const cell = (window.width - 2 * PADDING_PX) / shot.cols;
      if (cell < CLIP_MIN_CELL_PX) throw new Error(`${shot.name}: a column is ${cell.toFixed(1)} px wide, under ${CLIP_MIN_CELL_PX}`);
      isPrivate();
      // yuv420p needs even dimensions; the odd pixel is right or bottom padding.
      const area = { ...window, width: window.width - (window.width % 2), height: window.height - (window.height % 2) };
      const raw = join(scratch, `${shot.name}.raw.mkv`);
      recording = record(area, CLIP_FPS, raw, display, screenEnv, isPrivate);
      children.push(recording.ffmpeg);
      const played = await playClip(shot, tmux);
      const log = await recording.finish();
      isPrivate();
      return finishClip(shot, { raw, log, played, window, outDir, scratch, env });
    }
    const raw = join(scratch, `${shot.name}.raw.${shot.format === "gif" ? "mkv" : "png"}`);
    const out = join(outDir, `${shot.name}.${shot.format}`);
    const isGif = shot.format === "gif";
    if (isGif) {
      isPrivate();
      recording = record(window, RECORD_FPS, raw, display, screenEnv, isPrivate);
      children.push(recording.ffmpeg);
      await Bun.sleep(KEY_PAUSE_MS);
      for (const char of shot.command) {
        tmux.send("-l", char);
        await Bun.sleep(TYPE_MS);
      }
    } else {
      tmux.send("-l", shot.command);
    }
    let screen = await tmux.waitFor((current) => current.includes(shot.command.slice(0, 20)), READY_TIMEOUT_MS, "the command to be typed");
    if (isGif) await Bun.sleep(KEY_PAUSE_MS / 2);
    tmux.send("Enter");
    screen = await tmux.settle(screen);
    for (const key of shot.keys) {
      if (isGif) await Bun.sleep(KEY_PAUSE_MS);
      tmux.send(key);
      screen = await tmux.settle(screen);
    }
    await until(
      () => {
        const current = tmux.screen();
        if (current.includes("did not load")) throw new Error(`${shot.name}: the plugin snapshot did not load`);
        return shot.ready(current) ? true : undefined;
      },
      `${shot.name} to reach its state`,
      READY_TIMEOUT_MS,
    ).catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; the screen was:\n${tmux.screen()}`);
    });

    if (recording !== undefined) {
      await Bun.sleep(HOLD_MS);
      await recording.finish();
      isPrivate();
      toGif(raw, out, env);
    } else {
      await Bun.sleep(PAINT_MS);
      const shown = tmux.screen();
      assertPrivate(shown, forbidden);
      const area = shot.crop === "pane" ? paneArea(shown, window, shot) : window;
      run(["import", "-silent", "-window", "root", "-crop", `${area.width}x${area.height}+${area.x}+${area.y}`, "+repage", raw], screenEnv);
      assertPrivate(tmux.screen(), forbidden);
      run(["magick", raw, "-strip", "-define", "png:compression-level=9", "-define", "png:exclude-chunks=date,time", out], env);
    }
    return out;
  } finally {
    release();
    await stopAll();
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string" } },
  });
  const every: readonly Shot[] = [...SHOTS, ...CLIPS];
  const chosen =
    positionals.length === 0
      ? SHOTS
      : every.filter((shot) => positionals.includes(shot.name) || (shot.format === "clip" && positionals.includes("clips")));
  const unknown = positionals.filter((name) => name !== "clips" && !every.some((shot) => shot.name === name));
  if (unknown.length > 0 || chosen.length === 0) {
    console.error(`usage: bun scripts/docs/screenshots.ts [<name>... | clips] [--out <dir>]\nnames: ${every.map((shot) => shot.name).join(" ")}`);
    process.exit(2);
  }
  for (const shot of chosen) {
    const out = values.out ?? (shot.format === "clip" ? FOOTAGE_DIR : ASSET_DIR);
    mkdirSync(out, { recursive: true });
    console.log(await captureShot(shot, out));
  }
}
