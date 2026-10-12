import { SHAPE_PLATFORM, toPosix } from "./path.ts";

const PLAN_PATH_RE = /\/plans\/[^/]+\.md$/;

export function isPlanPath(filePath: string): boolean {
  return PLAN_PATH_RE.test(toPosix(SHAPE_PLATFORM, filePath));
}
