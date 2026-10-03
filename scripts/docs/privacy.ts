import { homedir, hostname, userInfo } from "node:os";
import { basename } from "node:path";

export const SCRATCH_PREFIX = "omca-shots-";
const MIN_LENGTH = 4;

export function machineValues(scratch: string): string[] {
  return [scratch, basename(scratch).slice(SCRATCH_PREFIX.length), homedir(), userInfo().username, hostname()];
}

// Pixels cannot be masked after the fact, so a screen that shows any of these values is refused
// before it is captured. Rows are also checked joined end to end, because a long path can wrap
// onto the next row. The error names the value by position only, so it never prints it.
export function assertPrivate(screen: string, forbidden: readonly string[]): void {
  const text = screen.toLowerCase();
  const joined = text
    .split("\n")
    .map((row) => row.trim())
    .join("");
  const at = forbidden.findIndex((value) => {
    const needle = value.toLowerCase();
    return needle.length >= MIN_LENGTH && (text.includes(needle) || joined.includes(needle));
  });
  if (at !== -1) throw new Error(`the screen shows a value from this machine (forbidden value ${at + 1}); refusing to capture it`);
}
