import { type Check, type Context, type Outcome, readText, verdict } from "./core.ts";
import { frontmatterLines } from "./frontmatter.ts";

const SHIPPED = /^(?:(?:agents|output-styles|templates)\/[^/]+|skills\/.+)\.md$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const PLUGIN_ROOT = "${CLAUDE_PLUGIN_ROOT}";

type Code = { line: number; text: string; inline: boolean };

function codeOf(source: string): Code[] {
  const lines = source.split(/\r?\n/);
  const front = frontmatterLines(source);
  const code: Code[] = [];
  let fence: string | undefined;
  for (let at = front === undefined ? 0 : front.length + 2; at < lines.length; at += 1) {
    const text = lines[at] ?? "";
    const marker = FENCE.exec(text)?.[1];
    if (fence === undefined && marker !== undefined) fence = marker;
    else if (fence !== undefined && marker?.startsWith(fence) === true) fence = undefined;
    else if (fence !== undefined) code.push({ line: at + 1, text, inline: false });
    else for (const span of text.matchAll(/(`+)(.+?)\1/g)) code.push({ line: at + 1, text: span[2] ?? "", inline: true });
  }
  return code;
}

function hasUnquotedPluginRoot({ text, inline }: Code): boolean {
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote === undefined && (char === '"' || char === "'")) quote = char;
    else if (char === quote) quote = undefined;
    else if (quote === undefined && text.startsWith(PLUGIN_ROOT, at) && !(inline && at === 0)) return true;
  }
  return false;
}

const FINDINGS: readonly { label: string; found: (code: Code) => boolean }[] = [
  { label: "sha256sum", found: ({ text }) => text.includes("sha256sum") },
  { label: "a /tmp path", found: ({ text }) => /(?<![\w.])\/tmp(?![\w-])/.test(text) },
  { label: "an unquoted ${CLAUDE_PLUGIN_ROOT} path", found: hasUnquotedPluginRoot },
];

function shellPortability(ctx: Context): Outcome {
  const problems = ctx
    .tracked()
    .filter((path) => SHIPPED.test(path))
    .flatMap((path) =>
      codeOf(readText(ctx.root, path)).flatMap((code) =>
        FINDINGS.filter(({ found }) => found(code)).map(({ label }) => `${path}:${code.line} uses ${label} in a code block`),
      ),
    );
  return verdict(problems, "no shipped skill, agent, output style or template code uses sha256sum, a /tmp path or an unquoted ${CLAUDE_PLUGIN_ROOT} path");
}

export const checks: readonly Check[] = [{ name: "shell portability", run: shellPortability }];
