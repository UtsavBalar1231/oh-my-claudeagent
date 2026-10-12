import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAIN_FRAME, svgOf } from "../../src/core/mascots.ts";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "assets", "icon.png");

for (const tool of ["rsvg-convert", "magick"]) {
  if (Bun.which(tool) === null) {
    console.error(`${tool} is not installed; the icon needs it.`);
    process.exit(1);
  }
}

function run(argv: string[]): void {
  const { exitCode, stderr } = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (exitCode !== 0) throw new Error(`${argv[0]} failed (${exitCode}): ${stderr.toString()}`);
}

const dir = mkdtempSync(join(tmpdir(), "omca-icon-"));
try {
  const svg = join(dir, "icon.svg");
  const png = join(dir, "icon.png");
  writeFileSync(svg, svgOf([PLAIN_FRAME], undefined, true));
  run(["rsvg-convert", "-w", "800", "-h", "800", "-o", png, svg]);
  run(["magick", png, "-trim", "+repage", "-background", "none", "-gravity", "center", "-extent", "512x512", "-strip", OUT]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
