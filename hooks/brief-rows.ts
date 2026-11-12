import type { RenderElement } from "claude-code";
import { type BriefField, briefFields, briefSize } from "../src/core/brief.ts";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { shortModel } from "../src/core/mission.ts";
import { type Glyphs, glyphs, shortType } from "../src/core/ui-kit.ts";
import { agentKey, TONE_KEYS } from "../src/core/visual.ts";
import type { Features } from "./dispatch.ts";
import { resolvedSession } from "./host.ts";
import { type Kit, kitOf } from "./ui.ts";

const MAX_TEXT = 100_000;
const MAX_RECORDS = 200;

type Spawned = { agentId: string; type: string; model: string; effort: string | number | null };

// Records are module values, not atoms: a render hook that reads an atom redraws on every write to it.
// Claude Code's row carries the Agent call's prompt and main's message byte for byte, so the text is the key.
const spawned = new Map<string, Spawned>();
const promptOf = new Map<string, string>();
const sent = new Set<string>();

function headerOf(kit: Kit, g: Glyphs, text: string): RenderElement {
  const size = briefSize(text, g.dot);
  const dim = (parts: readonly string[], lead = ""): RenderElement => kit.Text({ color: TONE_KEYS.muted, children: [lead + parts.join(` ${g.dot} `)] });
  const agent = spawned.get(text);
  if (agent !== undefined) {
    const facts = [shortModel(agent.model), agent.effort === null ? "" : String(agent.effort), size].filter((part) => part !== "");
    return kit.Text({
      wrap: "truncate-end",
      children: [kit.Text({ bold: true, color: agentKey(agent.type), children: [shortType(agent.type)] }), dim(facts, ` ${g.dot} `)],
    });
  }
  return kit.Text({ wrap: "truncate-end", children: [dim(sent.has(text) ? ["follow-up", size] : [size])] });
}

function fieldBox(kit: Kit, field: BriefField, index: number): RenderElement {
  const label =
    field.label === ""
      ? []
      : [
          kit.Text({
            children: [
              ...(field.num === "" ? [] : [kit.Text({ color: TONE_KEYS.muted, children: [`${field.num}. `] })]),
              kit.Text({ bold: true, color: TONE_KEYS.active, children: [field.label] }),
            ],
          }),
        ];
  const body = field.body === "" ? [] : [kit.Markdown({ text: field.body })];
  return kit.Box({ flexDirection: "column", ...(index === 0 ? {} : { marginTop: 1 }), children: [...label, ...body] });
}

// A brief main sends a subagent, and every later message main sends it, in the agent view on the terminal:
// a gutter, a dim header, OMCA's field labels in bold and each field's body through Claude Code's Markdown.
// ctrl+o draws the same tree, since the body is always shown in full.
export const briefRows: Features = {
  "agent.spawn": {
    post(_host, e, result) {
      if (result.deny !== undefined || result.agentId === undefined || e.resume !== undefined) return undefined;
      const { agentId } = result;
      const previous = spawned.get(e.prompt);
      if (previous !== undefined) promptOf.delete(previous.agentId);
      spawned.delete(e.prompt);
      spawned.set(e.prompt, { agentId, type: e.subagentType, model: result.model, effort: null });
      promptOf.set(agentId, e.prompt);
      for (const [oldest, record] of spawned) {
        if (spawned.size <= MAX_RECORDS) break;
        spawned.delete(oldest);
        promptOf.delete(record.agentId);
      }
      return undefined;
    },
  },
  "turn.step": {
    pre(_host, e) {
      if (e.agentId === undefined || e.effort === undefined) return undefined;
      const prompt = promptOf.get(e.agentId);
      const record = prompt === undefined ? undefined : spawned.get(prompt);
      if (record !== undefined && record.effort === null) record.effort = e.effort;
      return undefined;
    },
  },
  "tool.call": {
    pre(_host, e) {
      if (e.agentId !== undefined || e.tool !== "SendMessage" || typeof e.message !== "string") return undefined;
      sent.delete(e.message);
      sent.add(e.message);
      for (const oldest of sent) {
        if (sent.size <= MAX_RECORDS) break;
        sent.delete(oldest);
      }
      return undefined;
    },
  },
  "ui.render UserMessage": {
    pre(host, e) {
      const { text, origin } = e.props;
      if (e.surface !== "terminal" || origin.kind !== "coordinator" || text.length > MAX_TEXT) return undefined;
      const { glyphTier, disabledHooks } = resolvedSession();
      if (isHookDisabled(disabledHooks, "brief-rows")) return undefined;
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const g = glyphs(glyphTier);
      const fields = briefFields(text).map((field, index) => fieldBox(kit, field, index));
      return {
        answer: kit.Box({
          key: "omca-brief-rows",
          flexDirection: "row",
          children: [
            kit.Text({ color: TONE_KEYS.muted, children: [`${g.pointer} `] }),
            kit.Box({ flexDirection: "column", flexShrink: 1, children: [headerOf(kit, g, text), ...fields] }),
          ],
        }),
      };
    },
  },
};
