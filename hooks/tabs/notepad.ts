import { resolveBoundPlan } from "../../src/core/boulder.ts";
import { BOULDER } from "../../src/core/omca-paths.ts";
import { chunks, clean } from "../../src/core/plan-reader.ts";
import { fitEnd } from "../../src/core/ui-kit.ts";
import { type Host, reason, type State } from "../host.ts";
import { noticeRow, type TabView } from "../pane.ts";

type Notepad = NonNullable<State["pane"]["notepad"]>;
type Section = Notepad["sections"][number]["name"];

const SECTIONS: readonly Section[] = ["learnings", "issues", "decisions", "problems"];

let signature: string | undefined;

export const reset = (): void => {
  signature = undefined;
};

async function boundPlanName(host: Host, root: string): Promise<{ name: string; seen: string } | undefined> {
  const path = `${root}/${BOULDER}`;
  if (!(await host.fs.exists(path))) return undefined;
  const { mtimeMs } = await host.fs.stat(path);
  const bound = resolveBoundPlan(JSON.parse(await host.fs.read(path)), await host.session.id(), true);
  return "plan_name" in bound ? { name: bound.plan_name, seen: `${mtimeMs}` } : undefined;
}

// Unchanged files answer undefined, so a refresh writes, and redraws, nothing.
export async function read(
  host: Host,
  root: string,
): Promise<{ notepad: Notepad | null; error: string | null } | undefined> {
  try {
    const bound = await boundPlanName(host, root);
    if (bound === undefined) return signature === "unbound" ? undefined : ((signature = "unbound"), { notepad: null, error: null });
    const dir = `${root}/.omca/notepads/${bound.name}`;
    const files = (await host.fs.exists(dir)) ? await host.fs.list(dir) : [];
    const present = SECTIONS.flatMap((name) => {
      const file = files.find((entry) => entry.kind === "file" && entry.name === `${name}.md`);
      return file === undefined ? [] : [{ name, path: `${dir}/${file.name}`, seen: `${file.mtimeMs}:${file.size}` }];
    });
    const seen = [bound.name, bound.seen, ...present.map((section) => `${section.name}:${section.seen}`)].join("|");
    if (seen === signature) return undefined;
    const sections = await Promise.all(
      present.map(async (section) => ({ name: section.name, text: clean(await host.fs.read(section.path)).trim() })),
    );
    signature = seen;
    return { notepad: { planName: bound.name, sections: sections.filter((section) => section.text !== "") }, error: null };
  } catch (error) {
    const failure = `Could not read the notepad: ${reason(error)}`;
    if (signature === failure) return undefined;
    signature = failure;
    return { notepad: null, error: failure };
  }
}

const heading = (name: Section) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

export const view: TabView = async (host, view) => {
  const pane = (await host.state.pane.get()).value;
  const words = { loading: "Reading the notepad", empty: "No plan is bound to this session, so it has no notepad." };
  if (pane === undefined) return [noticeRow(view, { kind: "loading" }, words)];
  if (pane.errors.notepad !== null) return [noticeRow(view, { kind: "error", reason: pane.errors.notepad }, words)];
  const { notepad } = pane;
  if (notepad === null) return [noticeRow(view, { kind: "empty" }, words)];
  if (notepad.sections.length === 0) {
    return [noticeRow(view, { kind: "empty" }, { ...words, empty: `The notepad for ${notepad.planName} is empty.` })];
  }
  const { Box, Markdown, Text } = view.kit;
  return [
    Text({ dimColor: true, children: [fitEnd(`Notepad for ${notepad.planName}`, view.width, view.g.ellipsis)] }),
    ...notepad.sections.map((section) =>
      Box({
        key: `section-${section.name}`,
        flexDirection: "column",
        children: [
          Text({ children: [" "] }),
          Text({ bold: true, children: [heading(section.name)] }),
          ...chunks(section.text).map((text, part) => Markdown({ key: `notes-${section.name}-${part}`, text })),
        ],
      }),
    ),
  ];
};
