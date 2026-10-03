import { firstLine } from "./title.ts";

export function banner(text: string): string {
  return firstLine(text).toUpperCase();
}
