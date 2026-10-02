import type { EngineInterface, Register } from "claude-code";
import type { Host } from "./host.ts";

function bindHost($: EngineInterface): Host {
  return {
    log: (text) => $.ui.log(text, { to: "debug" }),
  };
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    bindHost($).log("oh-my-claudeagent hooks module loaded");
    return next(e);
  });
};
