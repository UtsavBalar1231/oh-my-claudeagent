import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guidanceTemplate } from "./guidance.ts";
import { handle } from "./keyword-detector.ts";
import { dispatch, type Output, type Payload } from "./registry.ts";
import { touchSession } from "./session-state.ts";

const NOW = 1_786_000_000_000;

const BANNERS = {
  handoff:
    "[HANDOFF MODE DETECTED] Handoff is user-driven and its skill cannot be model-invoked: suggest running /oh-my-claudeagent:handoff instead of improvising a summary.",
  setup: "[OMCA-SETUP DETECTED] Run /oh-my-claudeagent:omca-setup to configure the environment.",
  plan: "[PROMETHEUS DETECTED] Invoke /oh-my-claudeagent:plan for strategic planning via prometheus.",
  hephaestus: "[HEPHAESTUS DETECTED] Invoke /oh-my-claudeagent:hephaestus to fix build failures.",
};

const roots: string[] = [];

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "omca-keywords-"));
  roots.push(root);
  return root;
}

function writeMarker(root: string, sessionId: string, marker: unknown): void {
  mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
  writeFileSync(join(root, ".omca", "state", "mod", `${sessionId}.json`), typeof marker === "string" ? marker : JSON.stringify(marker));
}

const enable = (root: string, sessionId: string) => writeMarker(root, sessionId, { written_at: NOW, options: { enableKeywordTriggers: true } });

/** A project and session whose mod marker turns keyword triggers on. */
function enabled(): { root: string; sessionId: string } {
  const root = project();
  const sessionId = crypto.randomUUID();
  enable(root, sessionId);
  return { root, sessionId };
}

const submit = async (root: string, sessionId: string, prompt: string, extra: Record<string, unknown> = {}): Promise<Output | undefined> => {
  const payload: Payload = { event: "UserPromptSubmit", session_id: sessionId, prompt, ...extra };
  return handle(payload, { root, now: NOW, session: touchSession(sessionId) });
};

const announced = (...banners: string[]): Output => ({
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: banners.join("\n") },
});

const silent = async (root: string, sessionId: string, prompt: string, extra: Record<string, unknown> = {}) =>
  expect(await submit(root, sessionId, prompt, extra)).toBeUndefined();

describe("the enableKeywordTriggers option", () => {
  test("option unset: a trigger phrase injects nothing", async () => {
    await silent(project(), crypto.randomUUID(), "handoff please");
  });

  test("a marker without the option injects nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    writeMarker(root, sessionId, { written_at: NOW, options: { showBand: true, guardMode: "dialog" } });
    await silent(root, sessionId, "handoff please");
  });

  test("a marker with the option off injects nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    writeMarker(root, sessionId, { written_at: NOW, options: { enableKeywordTriggers: false } });
    await silent(root, sessionId, "handoff please");
  });

  test("an option that is not the boolean true injects nothing", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    writeMarker(root, sessionId, { written_at: NOW, options: { enableKeywordTriggers: "true" } });
    await silent(root, sessionId, "handoff please");
  });

  test("a marker with the option on lets the phrase through", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });

  test("another session's marker does not enable this session", async () => {
    const { root } = enabled();
    await silent(root, crypto.randomUUID(), "handoff please");
  });

  test("an unsafe session id injects nothing and reads no file outside the marker directory", async () => {
    const root = project();
    writeFileSync(join(root, "escape.json"), JSON.stringify({ options: { enableKeywordTriggers: true } }));
    mkdirSync(join(root, ".omca", "state", "mod"), { recursive: true });
    await silent(root, "../../../escape", "handoff please");
  });

  test("an unreadable marker is reported, not treated as an enabled option", async () => {
    const root = project();
    const sessionId = crypto.randomUUID();
    writeMarker(root, sessionId, "{ not json");
    await expect(submit(root, sessionId, "handoff please")).rejects.toThrow(SyntaxError);
  });

  test("a payload without a session id injects nothing", async () => {
    const { root } = enabled();
    expect(await handle({ event: "UserPromptSubmit", prompt: "handoff please" }, { root, now: NOW, session: undefined })).toBeUndefined();
  });
});

describe("handoff detection", () => {
  test("handoff: detects 'handoff please'", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });

  test("no keyword: a non-matching prompt injects nothing", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, "fix the login bug");
  });

  test("empty prompt: injects nothing", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, "");
  });

  test("a payload without a prompt injects nothing", async () => {
    const { root, sessionId } = enabled();
    expect(await handle({ event: "UserPromptSubmit", session_id: sessionId }, { root, now: NOW, session: touchSession(sessionId) })).toBeUndefined();
  });

  test("subagent skip: a payload carrying agent_id injects nothing", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, "handoff please", { agent_id: "sub-123" });
  });

  test("an empty agent_id, as the client fills an absent one, is the main thread", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "handoff please", { agent_id: "" })).toEqual(announced(BANNERS.handoff));
  });
});

describe("announcing a mode once per session", () => {
  test("echo-suppression case 1: first-fire announces and remembers the mode in session state", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
    expect(touchSession(sessionId).announcedModes).toEqual(new Set(["handoff"]));
  });

  test("echo-suppression case 2: same-session re-fire does NOT re-announce", async () => {
    const { root, sessionId } = enabled();
    await submit(root, sessionId, "handoff please");
    await silent(root, sessionId, "handoff please");
  });

  test("echo-suppression case 3: cross-session reset re-announces on new session", async () => {
    const first = enabled();
    const secondId = crypto.randomUUID();
    enable(first.root, secondId);
    await submit(first.root, first.sessionId, "handoff please");
    expect(await submit(first.root, secondId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });

  test("a second mode in the same session still announces beside the first", async () => {
    const { root, sessionId } = enabled();
    await submit(root, sessionId, "handoff please");
    expect(await submit(root, sessionId, "handoff please, and fix build")).toEqual(announced(BANNERS.hephaestus));
  });

  test("several new modes in one prompt announce together in table order", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "fix build, create plan and setup omca")).toEqual(
      announced(BANNERS.setup, BANNERS.plan, BANNERS.hephaestus),
    );
  });

  test("a mention that is silenced does not count as the announcement", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, 'the phrase "handoff" is a trigger');
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });
});

describe("text that is not a request for a mode", () => {
  test("task-notification: prompt containing <task-notification> tag does NOT activate any mode", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, "<task-notification><result>Agent completed: handoff plan hephaestus</result></task-notification>");
    expect(touchSession(sessionId).announcedModes).toBeUndefined();
  });

  test("task-notification: genuine 'handoff please' prompt still triggers handoff detection", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });

  test("mention: meta-cue 'the phrase' suppresses hephaestus detection", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, "Does the phrase fix build in a user prompt trigger hephaestus? I do not want you to fix anything.");
  });

  test("mention: quoted trigger phrases suppress omca-setup and prometheus detection", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, 'Document that "setup omca" and "create plan" are the trigger phrases; do not run them.');
  });

  test("mention: quoting alone suppresses detection without a meta-cue", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, 'I pasted "setup omca" into the doc yesterday.');
  });

  test("mention control: unquoted 'fix build' still triggers hephaestus", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "the build is failing, fix build please")).toEqual(announced(BANNERS.hephaestus));
  });

  test("mention control: unquoted 'setup omca' still triggers omca-setup", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "setup omca on this machine")).toEqual(announced(BANNERS.setup));
  });

  test("mention control: unquoted 'create plan' still triggers prometheus", async () => {
    const { root, sessionId } = enabled();
    expect(await submit(root, sessionId, "create plan for the auth rewrite")).toEqual(announced(BANNERS.plan));
  });

  test("pasted content: a trigger phrase inside marked pasted text does not fire", async () => {
    const { root, sessionId } = enabled();
    await silent(root, sessionId, 'look at this log\n<pasted_content id="a1b2">\nerror: build broken at step 3\n</pasted_content id="a1b2">\nwhat failed?');
  });

  test("pasted content: the same phrase typed outside the paste still fires", async () => {
    const { root, sessionId } = enabled();
    expect(
      await submit(root, sessionId, '<pasted_content id="a1b2">\nsome log line\n</pasted_content id="a1b2">\nfix build please'),
    ).toEqual(announced(BANNERS.hephaestus));
  });
});

describe("kill switch", () => {
  test("OMCA_DISABLED_HOOKS listing keyword-detector injects nothing and announces nothing", async () => {
    const { root, sessionId } = enabled();
    process.env.OMCA_DISABLED_HOOKS = "keyword-detector";
    await silent(root, sessionId, "handoff please");
    delete process.env.OMCA_DISABLED_HOOKS;
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });

  test("OMCA_DISABLED_HOOKS naming another hook leaves the detector on", async () => {
    const { root, sessionId } = enabled();
    process.env.OMCA_DISABLED_HOOKS = "slash-mode-detector";
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });

  test("only the exact hook name disables it", async () => {
    const { root, sessionId } = enabled();
    process.env.OMCA_DISABLED_HOOKS = "keyword-detector-extra";
    expect(await submit(root, sessionId, "handoff please")).toEqual(announced(BANNERS.handoff));
  });
});

describe("beside the guidance handler", () => {
  const prompt = (sessionId: string, text: string): Payload => ({ event: "UserPromptSubmit", session_id: sessionId, cwd: "/work", prompt: text });

  test("the first prompt carries the template, then the banner, in one context", async () => {
    const { root, sessionId } = enabled();
    expect(await dispatch(prompt(sessionId, "handoff please"), root, NOW)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `${guidanceTemplate()}\nSession ${sessionId}\n\n${BANNERS.handoff}`,
      },
    });
  });

  test("a later prompt carries the banner alone", async () => {
    const { root, sessionId } = enabled();
    await dispatch(prompt(sessionId, "add a hello command"), root, NOW);
    expect(await dispatch(prompt(sessionId, "fix build"), root, NOW)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: BANNERS.hephaestus },
    });
  });

  test("a prompt with no phrase carries no banner after the guidance", async () => {
    const { root, sessionId } = enabled();
    await dispatch(prompt(sessionId, "add a hello command"), root, NOW);
    expect(await dispatch(prompt(sessionId, "add a goodbye command"), root, NOW)).toEqual({});
  });
});

describe("a full hook payload", () => {
  test("a prompt with no keyword answers nothing", async () => {
    const root = project();
    enable(root, "fixture-sid-001");
    const fixture = { prompt: "fix the login bug", session_id: "fixture-sid-001" };
    await silent(root, fixture.session_id, fixture.prompt);
  });
});
