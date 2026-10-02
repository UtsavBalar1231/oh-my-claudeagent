import { handle as commentGate } from "./comment-gate.ts";
import { handle as contextInjector } from "./context-injector.ts";
import { handle as emptyTaskResponse } from "./empty-task-response.ts";
import { handle as failureRecovery } from "./failure-recovery.ts";
import { handle as guidance } from "./guidance.ts";
import { handle as keywordDetector } from "./keyword-detector.ts";
import { handle as permissionCoach } from "./permission-coach.ts";
import { handle as planFormatWarn } from "./plan-format-warn.ts";
import { handle as planWriteGuard } from "./plan-write-guard.ts";
import { type Session, touchSession } from "./session-state.ts";
import { handle as sessionStart } from "./session-start.ts";
import { handle as slashModeDetector } from "./slash-mode-detector.ts";
import { isSafeId, stampIfDue } from "./status-file.ts";
import { handle as stopGates } from "./stop-gates.ts";
import { handle as subagentContext } from "./subagent-context.ts";
import { handle as taskCompleted } from "./task-completed.ts";
import { handle as trustedTooling } from "./trusted-tooling.ts";
import { handle as verificationRecorder } from "./verification-recorder.ts";

/** The hook payload as the handlers see it: object-valued fields already decoded. */
export type Payload = Readonly<Record<string, unknown>> & { readonly event: string };

export type Output = {
  decision?: "block";
  reason?: string;
  hookSpecificOutput?: { hookEventName: string; [field: string]: unknown };
};

export type Context = { root: string; now: number; session: Session | undefined };

export type Handler = (payload: Payload, context: Context) => Output | undefined | Promise<Output | undefined>;

export const REGISTRY: Readonly<Record<string, readonly (readonly [string, Handler])[]>> = {
  PreToolUse: [
    ["plan-write-guard", planWriteGuard],
    ["comment-gate", commentGate],
  ],
  PermissionRequest: [["trusted-tooling", trustedTooling]],
  PostToolUse: [
    ["verification-recorder", verificationRecorder],
    ["context-injector", contextInjector],
    ["plan-format-warn", planFormatWarn],
    ["empty-task-response", emptyTaskResponse],
  ],
  PostToolUseFailure: [["failure-recovery", failureRecovery]],
  UserPromptSubmit: [
    ["guidance", guidance],
    ["keyword-detector", keywordDetector],
  ],
  UserPromptExpansion: [
    ["guidance", guidance],
    ["slash-mode-detector", slashModeDetector],
  ],
  SubagentStart: [["subagent-context", subagentContext]],
  PermissionDenied: [["permission-coach", permissionCoach]],
  TaskCompleted: [["task-completed", taskCompleted]],
  Stop: [["stop-gates", stopGates]],
  SessionStart: [["session-start", sessionStart]],
};

const OBJECT_FIELDS = ["tool_input", "tool_response", "tool_calls", "background_tasks"];

// The client substitutes an absent path as "", an object as JSON, and a string as the raw
// string, so text that is not JSON is the field's own string value.
function decode(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function payloadOf(args: Readonly<Record<string, unknown>> & { event: string }): Payload {
  return { ...args, ...Object.fromEntries(OBJECT_FIELDS.map((field) => [field, decode(args[field])])) };
}

export const isDeny = (output: Output): boolean => output.hookSpecificOutput?.permissionDecision === "deny";
export const isBlock = (output: Output): boolean => output.decision === "block";

function combine(answers: readonly Output[]): Output {
  const decisive = answers.find(isDeny) ?? answers.find(isBlock);
  if (decisive !== undefined) return decisive;
  let merged: Output["hookSpecificOutput"];
  for (const { hookSpecificOutput: next } of answers) {
    if (next === undefined) continue;
    if (merged === undefined) {
      merged = { ...next };
      continue;
    }
    const context = [merged.additionalContext, next.additionalContext].filter((text) => typeof text === "string");
    merged = { ...next, ...merged, ...(context.length > 0 && { additionalContext: context.join("\n\n") }) };
  }
  return merged === undefined ? {} : { hookSpecificOutput: merged };
}

const failureDeny = (name: string, error: unknown): Output => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `OMCA's ${name} check failed, so this call is denied: ${error instanceof Error ? error.message : String(error)}`,
  },
});

function sessionOf(id: unknown): Session | undefined {
  if (typeof id !== "string" || id === "") return undefined;
  if (isSafeId(id)) return touchSession(id);
  console.error(`omca: ignoring hook session state for an unsafe session id ${JSON.stringify(id)}`);
  return undefined;
}

export async function dispatch(payload: Payload, root: string, now = Date.now(), registry = REGISTRY): Promise<Output> {
  const handlers = registry[payload.event];
  if (handlers === undefined) {
    console.error(`omca: omca_hook has no handlers for event ${JSON.stringify(payload.event)}`);
    return {};
  }
  const context: Context = { root, now, session: sessionOf(payload.session_id) };
  const answers: Output[] = [];
  for (const [name, handler] of handlers) {
    try {
      const answer = await handler(payload, context);
      if (answer !== undefined) answers.push(answer);
    } catch (error) {
      console.error(`omca: ${payload.event} handler ${name} failed:`, error);
      if (payload.event === "PreToolUse") answers.push(failureDeny(name, error));
    }
  }
  if (context.session !== undefined) {
    try {
      stampIfDue(root, context.session, now);
    } catch (error) {
      console.error(`omca: could not stamp the status file for session ${context.session.id}:`, error);
    }
  }
  return combine(answers);
}
