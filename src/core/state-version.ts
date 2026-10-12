import { isRecord } from "./tool-input.ts";

export const STATE_VERSION = 1;

export type Refusal = { kind: "refused"; code: "unparseable" | "shape" | "version"; reason: string };

export const refuse = (code: Refusal["code"], reason: string): Refusal => ({ kind: "refused", code, reason });

/** The top-level object of a durable state file, or why the file is refused. A file without `version` reads as version 1. */
export function parseDocument(text: string): { kind: "ok"; document: Record<string, unknown> } | Refusal {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return refuse("unparseable", "it is not valid JSON");
  }
  if (!isRecord(data)) return refuse("shape", "it is not a JSON object");
  if (Object.hasOwn(data, "version") && data["version"] !== STATE_VERSION) {
    return refuse("version", `its "version" is ${JSON.stringify(data["version"])}, and only version ${STATE_VERSION} is supported`);
  }
  return { kind: "ok", document: data };
}
