import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const here = (path: string): string => new URL(path, import.meta.url).pathname;

const serveUrl = await bundle({ entryPoint: here("./src/index.ts") });
const poster = await selectComposition({ serveUrl, id: "Poster" });
const output = here("./out/poster.png");
await renderStill({ serveUrl, composition: poster, output, imageFormat: "png" });
console.log(`wrote ${output}`);
