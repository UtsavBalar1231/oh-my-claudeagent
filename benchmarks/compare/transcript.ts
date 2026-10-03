export type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
export type ToolUse = { name: string; input: Record<string, unknown> };
export type RunResult = { isError: boolean; subtype: string; turns: number; durationMs: number; usage: Usage; text: string };
export type Transcript = { toolUses: ToolUse[]; lastAssistantText: string; result: RunResult | null };

export const WRITE_TOOLS: readonly string[] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function parseTranscript(text: string): Transcript {
  const toolUses: ToolUse[] = [];
  let lastAssistantText = "";
  let result: RunResult | null = null;
  for (const line of text.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use" && typeof block.name === "string") toolUses.push({ name: block.name, input: isRecord(block.input) ? block.input : {} });
        if (block.type === "text" && typeof block.text === "string") lastAssistantText = block.text;
      }
    }
    if (event.type === "result") {
      const usage = isRecord(event.usage) ? event.usage : {};
      result = {
        isError: event.is_error === true,
        subtype: typeof event.subtype === "string" ? event.subtype : "",
        turns: num(event.num_turns),
        durationMs: num(event.duration_ms),
        usage: { input: num(usage.input_tokens), output: num(usage.output_tokens), cacheWrite: num(usage.cache_creation_input_tokens), cacheRead: num(usage.cache_read_input_tokens) },
        text: typeof event.result === "string" ? event.result : "",
      };
    }
  }
  return { toolUses, lastAssistantText, result };
}

export const finalText = (t: Transcript): string => t.result?.text || t.lastAssistantText;

const USAGE_LIMIT = /hit your \w+ limit|usage limit|Request rejected \(429\)|Credit balance is too low/i;

export const hitUsageLimit = (t: Transcript, stderr: string): boolean =>
  t.result === null ? USAGE_LIMIT.test(stderr) : t.result.isError && USAGE_LIMIT.test(t.result.text);
