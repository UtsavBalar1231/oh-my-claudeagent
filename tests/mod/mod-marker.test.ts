import type { On } from "claude-code";
import { type Engine, expect, test } from "claude-code/testing";
import { ROOT, SESSION, type World, world, write } from "./world.ts";

const MARKER = `${ROOT}/.omca/state/mod/${SESSION}.json`;
const STARTED_MS = Date.UTC(2026, 9, 2, 12, 0, 0);

function engine(on: On): World {
  const w = world(on);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("session.usage", () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("fs.write", (_$, e) => (write(w, e.path, e.text), { value: undefined }));
  return w;
}

const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: "terminal", isInteractive: true });
const marker = (w: World): unknown => JSON.parse(w.files.get(MARKER)?.text ?? "null");

test("session start writes the marker with its time, the plugin version and the options", async ($, on) => {
  const w = engine(on);
  await start($);
  const manifest = w.reads.find((path) => path.endsWith("/.claude-plugin/plugin.json")) ?? "";
  expect(marker(w)).toEqual({ written_at: STARTED_MS, version: null, options: { showBand: true, guardMode: "dialog", enableKeywordTriggers: false } });
  expect(w.logs.some((line) => line.startsWith("mod-marker: cannot read the plugin version"))).toBe(true);

  write(w, manifest, '{ "name": "oh-my-claudeagent", "version": "3.0.0" }');
  await w.clock.advance(60_000);
  await $.turn.start({ text: "go", turnId: "t-1" });
  expect(marker(w)).toEqual({
    written_at: STARTED_MS + 60_000,
    version: "3.0.0",
    options: { showBand: true, guardMode: "dialog", enableKeywordTriggers: false },
  });
});

test("each main-loop turn start rewrites the marker with the turn's time", async ($, on) => {
  const w = engine(on);
  await start($);
  for (const turnId of ["t-1", "t-2"]) {
    await w.clock.advance(1_000);
    await $.turn.start({ text: "go", turnId });
  }
  expect(marker(w)).toMatchObject({ written_at: STARTED_MS + 2_000 });
});

test("the marker carries the plugin option that turns keyword triggers on", { options: { enableKeywordTriggers: true } }, async ($, on) => {
  const w = engine(on);
  await start($);
  expect(marker(w)).toMatchObject({ options: { enableKeywordTriggers: true } });
});
