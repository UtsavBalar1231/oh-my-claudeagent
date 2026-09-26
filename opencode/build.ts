import { join } from "node:path";
import { generate } from "./lib.ts";

const root = join(import.meta.dir, "..");
await Bun.write(join(root, "opencode/generated/omca.json"), JSON.stringify(generate(root), null, 2) + "\n");
