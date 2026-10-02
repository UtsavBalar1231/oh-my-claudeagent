import type { Args, EventResult, Frozen, RenderElement, RenderInput } from "claude-code";
import type { Host } from "./host.ts";

type Sites = {
  "tool.check": [Args<"tool.check">, EventResult<"tool.check">];
  "session.start": [Args<"session.start">, EventResult<"session.start">];
  "turn.start": [Args<"turn.start">, EventResult<"turn.start">];
  "turn.step": [Args<"turn.step">, EventResult<"turn.step">];
  "turn.complete": [Args<"turn.complete">, EventResult<"turn.complete">];
  "agent.spawn": [Args<"agent.spawn">, EventResult<"agent.spawn">];
  "prompt.edit": [Args<"prompt.edit">, EventResult<"prompt.edit">];
  "ui.close": [Args<"ui.close">, EventResult<"ui.close">];
  "ui.focus": [Args<"ui.focus">, EventResult<"ui.focus">];
  "command.run": [Args<"command.run">, EventResult<"command.run">];
  "ui.render AbovePrompt": [RenderInput<"AbovePrompt">, RenderElement];
  "ui.render Pane": [RenderInput<"Pane">, RenderElement];
  "session.compact": [Args<"session.compact">, EventResult<"session.compact">];
};

export type Site = keyof Sites;

type Awaitable<T> = T | Promise<T>;

export type Phase<E, A> = { event: E } | { answer: A };

export type Feature<E, R, A = R, H = Host> = {
  pre?: (host: H, e: E) => Awaitable<Phase<E, A> | undefined>;
  post?: (host: H, e: E, result: R) => Awaitable<A | undefined>;
};

type Logs = { log: (text: string) => void };

export type Input<S extends Site> = Frozen<Sites[S][0]>;

export type Features = {
  [S in Site]?: Feature<Input<S>, Sites[S][1], S extends "turn.step" ? never : Sites[S][1]>;
};

export type Entries<S extends Site> = readonly (readonly [string, NonNullable<Features[S]>])[];

export function featuresFor<S extends Site>(site: S, modules: Readonly<Record<string, Features>>): Entries<S> {
  return Object.entries(modules).flatMap(([name, module]) => {
    const feature = module[site];
    return feature === undefined ? [] : [[name, feature] as const];
  });
}

async function attempt<T>(host: Logs, where: string, call: () => Awaitable<T>): Promise<{ value: T } | { reason: string }> {
  try {
    return { value: await call() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    host.log(`${where} failed: ${reason}`);
    return { reason };
  }
}

function rank(answer: unknown): number {
  if (typeof answer !== "object" || answer === null) return 3;
  if ("deny" in answer && answer.deny !== undefined) return 0;
  if ("decision" in answer && answer.decision === "deny") return 0;
  if ("block" in answer && answer.block !== undefined) return 1;
  if ("text" in answer && answer.text !== undefined) return 2;
  return 3;
}

function winner<A>(answers: readonly A[]): A | undefined {
  return answers.reduce<A | undefined>(
    (best, answer) => (best === undefined || rank(answer) < rank(best) ? answer : best),
    undefined,
  );
}

export async function dispatch<H extends Logs, E, R>(
  host: H,
  where: string,
  features: readonly (readonly [string, Feature<E, R, R, H>])[],
  e: E,
  next: (e: E) => Promise<R>,
  failed?: (reason: string) => R,
): Promise<R> {
  const answers: R[] = [];
  let event = e;
  for (const [name, { pre }] of features) {
    if (pre === undefined) continue;
    const run = await attempt(host, `${name} pre ${where}`, () => pre(host, event));
    if (!("value" in run)) {
      if (failed !== undefined) answers.push(failed(run.reason));
    } else if (run.value !== undefined && "answer" in run.value) answers.push(run.value.answer);
    else if (run.value !== undefined) event = run.value.event;
  }
  const early = winner(answers);
  if (early !== undefined) return early;
  const result = await next(event);
  for (const [name, { post }] of features) {
    if (post === undefined) continue;
    const run = await attempt(host, `${name} post ${where}`, () => post(host, event, result));
    if (!("value" in run)) {
      if (failed !== undefined) answers.push(failed(run.reason));
    } else if (run.value !== undefined) answers.push(run.value);
  }
  return winner(answers) ?? result;
}

export async function* dispatchStream<H extends Logs, E, C, R>(
  host: H,
  where: string,
  features: readonly (readonly [string, Feature<E, R, never, H>])[],
  e: E,
  next: (e: E) => AsyncGenerator<C, R>,
): AsyncGenerator<C, R> {
  let event = e;
  for (const [name, { pre }] of features) {
    if (pre === undefined) continue;
    const run = await attempt(host, `${name} pre ${where}`, () => pre(host, event));
    if ("value" in run && run.value !== undefined && "event" in run.value) event = run.value.event;
  }
  const result = yield* next(event);
  for (const [name, { post }] of features) {
    if (post !== undefined) await attempt(host, `${name} post ${where}`, () => post(host, event, result));
  }
  return result;
}
