import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { HERE } from "./harness.ts";

const EVAL_FIXTURES = join(HERE, "fixtures", "eval");
const SUFFIX = ".fixture";

export function materialize(source: string, dest: string): void {
  for (const relative of new Bun.Glob("**/*").scanSync({ cwd: source, dot: true, onlyFiles: true })) {
    const target = join(dest, relative.endsWith(SUFFIX) ? relative.slice(0, -SUFFIX.length) : relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, relative), target);
  }
}

export type CaseFixture = { project: string; hidden: string | null };

export function prepareCaseFixture(caseId: string, root: string): CaseFixture {
  rmSync(root, { recursive: true, force: true });
  const project = join(root, "project");
  materialize(join(EVAL_FIXTURES, "project"), project);
  const overlay = join(EVAL_FIXTURES, "overlays", caseId);
  if (existsSync(overlay)) materialize(overlay, project);
  const hiddenSource = join(EVAL_FIXTURES, "hidden", caseId);
  if (!existsSync(hiddenSource)) return { project, hidden: null };
  const hidden = join(root, "hidden");
  materialize(hiddenSource, hidden);
  return { project, hidden };
}
