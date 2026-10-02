import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guidanceTemplate } from "./guidance.ts";
import { handle as keywordDetector } from "./keyword-detector.ts";
import { dispatch, type Output, type Payload } from "./registry.ts";
import { touchSession } from "./session-state.ts";
import { handle } from "./slash-mode-detector.ts";

const NOW = 1_786_000_000_000;
const BANNER = "[HANDOFF MODE ACTIVATED via slash command] Create session handoff summary for new-session continuity.";
const KEYWORD_BANNER =
  "[HANDOFF MODE DETECTED] Handoff is user-driven and its skill cannot be model-invoked: suggest running /oh-my-claudeagent:handoff instead of improvising a summary.";
const ROOT = mkdtempSync(join(tmpdir(), "omca-slash-"));

afterEach(() => {
  delete process.env.OMCA_DISABLED_HOOKS;
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const expansion = (sessionId: string, commandName: string | undefined): Payload => ({
  event: "UserPromptExpansion",
  session_id: sessionId,
  command_name: commandName,
  command_args: [],
  command_source: "plugin",
  expansion_type: "slash_command",
  prompt: "",
});

const expand = async (sessionId: string, commandName: string | undefined): Promise<Output | undefined> =>
  handle(expansion(sessionId, commandName), { root: ROOT, now: NOW, session: touchSession(sessionId) });

function enableKeywords(sessionId: string): void {
  mkdirSync(join(ROOT, ".omca", "state", "mod"), { recursive: true });
  writeFileSync(join(ROOT, ".omca", "state", "mod", `${sessionId}.json`), JSON.stringify({ options: { enableKeywordTriggers: true } }));
}

const activated: Output = { hookSpecificOutput: { hookEventName: "UserPromptExpansion", additionalContext: BANNER } };

const silent = async (sessionId: string, commandName: string | undefined) =>
  expect(await expand(sessionId, commandName)).toBeUndefined();

describe("handoff slash command", () => {
  test("handoff: /oh-my-claudeagent:handoff activates handoff mode and emits banner", async () => {
    const sessionId = crypto.randomUUID();
    expect(await expand(sessionId, "oh-my-claudeagent:handoff")).toEqual(activated);
    expect(touchSession(sessionId).announcedModes).toEqual(new Set(["handoff"]));
  });

  test("a payload without a session id still announces", async () => {
    const payload = expansion("unused", "oh-my-claudeagent:handoff");
    expect(await handle(payload, { root: ROOT, now: NOW, session: undefined })).toEqual(activated);
  });
});

describe("commands that are not modes", () => {
  test("non-omca: /recap produces no mode activation", async () => {
    const sessionId = crypto.randomUUID();
    await silent(sessionId, "recap");
    expect(touchSession(sessionId).announcedModes).toBeUndefined();
  });

  test("non-omca: /code-review:code-review produces no mode activation", async () => {
    await silent(crypto.randomUUID(), "code-review:code-review");
  });

  test("another plugin's handoff command is not OMCA's", async () => {
    await silent(crypto.randomUUID(), "other-plugin:handoff");
  });

  test("non-mode omca: /oh-my-claudeagent:plan produces no mode activation", async () => {
    await silent(crypto.randomUUID(), "oh-my-claudeagent:plan");
  });

  test("a name that is an object property is not a mode", async () => {
    await silent(crypto.randomUUID(), "constructor");
  });

  test("empty command_name: produces no activation", async () => {
    await silent(crypto.randomUUID(), "");
  });

  test("missing command_name field: produces no activation", async () => {
    const sessionId = crypto.randomUUID();
    const payload: Payload = { event: "UserPromptExpansion", session_id: sessionId, expansion_type: "slash_command", prompt: "fix something" };
    expect(await handle(payload, { root: ROOT, now: NOW, session: touchSession(sessionId) })).toBeUndefined();
  });
});

describe("announcing the mode once per session", () => {
  test("echo-suppression: same-session re-fire does NOT re-announce handoff", async () => {
    const sessionId = crypto.randomUUID();
    await expand(sessionId, "oh-my-claudeagent:handoff");
    await silent(sessionId, "oh-my-claudeagent:handoff");
  });

  test("echo-suppression: cross-session re-announces handoff on new session", async () => {
    await expand(crypto.randomUUID(), "oh-my-claudeagent:handoff");
    expect(await expand(crypto.randomUUID(), "oh-my-claudeagent:handoff")).toEqual(activated);
  });

  test("a keyword-announced handoff suppresses the slash banner in the same session", async () => {
    const sessionId = crypto.randomUUID();
    enableKeywords(sessionId);
    const submitted: Payload = { event: "UserPromptSubmit", session_id: sessionId, prompt: "handoff please" };
    expect(await keywordDetector(submitted, { root: ROOT, now: NOW, session: touchSession(sessionId) })).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: KEYWORD_BANNER },
    });
    await silent(sessionId, "oh-my-claudeagent:handoff");
  });

  test("a slash-announced handoff suppresses the keyword banner for the command's own prompt", async () => {
    const sessionId = crypto.randomUUID();
    enableKeywords(sessionId);
    await expand(sessionId, "oh-my-claudeagent:handoff");
    const submitted: Payload = { event: "UserPromptSubmit", session_id: sessionId, prompt: "/oh-my-claudeagent:handoff" };
    expect(await keywordDetector(submitted, { root: ROOT, now: NOW, session: touchSession(sessionId) })).toBeUndefined();
  });
});

describe("kill switch", () => {
  test("OMCA_DISABLED_HOOKS listing slash-mode-detector activates nothing and announces nothing", async () => {
    const sessionId = crypto.randomUUID();
    process.env.OMCA_DISABLED_HOOKS = "slash-mode-detector";
    await silent(sessionId, "oh-my-claudeagent:handoff");
    delete process.env.OMCA_DISABLED_HOOKS;
    expect(await expand(sessionId, "oh-my-claudeagent:handoff")).toEqual(activated);
  });

  test("OMCA_DISABLED_HOOKS naming another hook leaves the detector on", async () => {
    process.env.OMCA_DISABLED_HOOKS = "keyword-detector";
    expect(await expand(crypto.randomUUID(), "oh-my-claudeagent:handoff")).toEqual(activated);
  });
});

describe("beside the guidance handler", () => {
  test("a first prompt that is the slash command carries the template, then the banner, in one context", async () => {
    const sessionId = crypto.randomUUID();
    expect(await dispatch(expansion(sessionId, "oh-my-claudeagent:handoff"), ROOT, NOW)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptExpansion",
        additionalContext: `${guidanceTemplate()}\nSession ${sessionId}\n\n${BANNER}`,
      },
    });
  });

  test("a later slash command carries the banner alone", async () => {
    const sessionId = crypto.randomUUID();
    await dispatch(expansion(sessionId, "oh-my-claudeagent:plan"), ROOT, NOW);
    expect(await dispatch(expansion(sessionId, "oh-my-claudeagent:handoff"), ROOT, NOW)).toEqual(activated);
  });
});
