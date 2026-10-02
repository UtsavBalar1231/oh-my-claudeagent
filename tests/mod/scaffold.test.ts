import { expect, test } from "claude-code/testing";

test("the module registers session.start and nothing else", async ($, on) => {
  const events: string[][] = [];
  on("plugin.register", (_$, e) => {
    if (e.name === "oh-my-claudeagent") events.push([...e.uses.events]);
    return { allow: true };
  });
  on("session.start", () => ({ cwd: "/engine" }));
  on("ui.log", () => ({ value: undefined }));

  await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });

  expect(events).toEqual([["session.start"]]);
});

test("session.start logs the load line to the debug log and passes the engine's answer through", async ($, on) => {
  const logs: Array<{ text: string; to: string | undefined }> = [];
  on("session.start", () => ({ cwd: "/engine" }));
  on("ui.log", (_$, e) => {
    logs.push({ text: e.text, to: e.to });
    return { value: undefined };
  });

  const result = await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });

  expect(result).toEqual({ cwd: "/engine" });
  expect(logs).toEqual([{ text: "oh-my-claudeagent hooks module loaded", to: "debug" }]);
});
