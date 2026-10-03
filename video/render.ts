import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, RenderInternals, selectComposition } from "@remotion/renderer";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENTS } from "./src/agents.ts";

const here = (path: string): string => new URL(path, import.meta.url).pathname;
const out = (name: string): string => here(`./out/${name}`);

const MASTER = out("omca-demo.mp4");
const POSTER = out("poster.png");
const WEB = out("omca-demo-web.mp4");
const GIF = out("omca-loop.gif");
// GitHub's upload limit on a free plan is 10 MB, and the check uses the decimal figure.
const UPLOAD_LIMIT = 10_000_000;
const WEB_CRF = 26;
const WEB_FALLBACK_KBPS = 1000;

// The ffmpeg and ffprobe that ship with Remotion, so a machine without its own still renders. Their
// build carries few filters and muxers (no fps, select or rawvideo), so the web cut resamples with
// -r and the GIF check compares its first and last frames as PNG files.
const binary = (type: "ffmpeg" | "ffprobe") => RenderInternals.getExecutablePath({ type, indent: false, logLevel: "error", binariesDirectory: null });
const env = { ...process.env, LD_LIBRARY_PATH: dirname(binary("ffmpeg")) };

const spawn = (type: "ffmpeg" | "ffprobe", args: string[]): Buffer => {
  const result = spawnSync(binary(type), args, { env, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`${type} ${args.join(" ")} exited ${result.status}: ${result.stderr.toString()}`);
  return result.stdout;
};
const run = (type: "ffmpeg" | "ffprobe", args: string[]): string => spawn(type, args).toString();

const progress = (label: string) => {
  let shown = -1;
  return ({ progress: done }: { progress: number }) => {
    const step = Math.floor(done * 10);
    if (step > shown) {
      shown = step;
      console.log(`${label} ${step * 10}%`);
    }
  };
};

// The capabilities beat lists the specialists from agents/*.md; a renamed, added or re-tiered agent
// stops the render rather than ship a stale roster.
const frontmatter = (file: string) => {
  const head = readFileSync(file, "utf8").split("---")[1] ?? "";
  const field = (key: string) => head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
  return `${field("name")}:${field("model")}`;
};
const declared = readdirSync(here("../agents")).filter((f) => f.endsWith(".md")).map((f) => frontmatter(here(`../agents/${f}`))).sort();
const shown = AGENTS.map((a) => `${a.name}:${a.model}`).sort();
if (declared.join() !== shown.join()) throw new Error(`video/src/agents.ts is out of date with agents/*.md:\n  agents/  ${declared.join(" ")}\n  video    ${shown.join(" ")}`);

mkdirSync(here("./out"), { recursive: true });
const serveUrl = await bundle({ entryPoint: here("./src/index.ts") });

const demo = await selectComposition({ serveUrl, id: "Demo" });
await renderMedia({
  serveUrl,
  composition: demo,
  codec: "h264",
  crf: 18,
  imageFormat: "png",
  pixelFormat: "yuv420p",
  colorSpace: "bt709",
  muted: true,
  outputLocation: MASTER,
  // Each tab's frame cache defaults to half the free memory, and one decoded 4K frame is about
  // 29 MB. With the sizzle's many 4K clips a tab crashed ("Page crashed!", 2026-10-04) at a 0.8 GB
  // budget even alone, and ran clean at 300 MB in three tabs. A longer per-frame timeout covers a
  // seek from a clip's start.
  concurrency: 3,
  mediaCacheSizeInBytes: 300_000_000,
  timeoutInMilliseconds: 120_000,
  onProgress: progress("master"),
});

const poster = await selectComposition({ serveUrl, id: "Poster" });
await renderStill({ serveUrl, composition: poster, frame: 0, output: POSTER, imageFormat: "png" });

const tags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
const web = ["-y", "-i", MASTER, "-r", "30", "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-pix_fmt", "yuv420p", ...tags, "-an"];
run("ffmpeg", [...web, "-crf", String(WEB_CRF), "-movflags", "+faststart", WEB]);
if (statSync(WEB).size >= UPLOAD_LIMIT) {
  const rate = ["-b:v", `${WEB_FALLBACK_KBPS}k`, "-passlogfile", out("web-pass")];
  run("ffmpeg", [...web, ...rate, "-pass", "1", "-f", "null", "/dev/null"]);
  run("ffmpeg", [...web, ...rate, "-pass", "2", "-movflags", "+faststart", WEB]);
}

// A GIF takes no CRF; the Loop composition's own 15 fps sets the frame rate.
const loop = await selectComposition({ serveUrl, id: "Loop" });
await renderMedia({ serveUrl, composition: loop, codec: "gif", imageFormat: "png", outputLocation: GIF, onProgress: progress("loop") });

type Stream = { width: number; height: number; r_frame_rate: string; color_space?: string; color_primaries?: string; color_transfer?: string };
const probe = (file: string): { stream: Stream; duration: number } => {
  const json = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,color_space,color_primaries,color_transfer:format=duration", "-of", "json", file]));
  return { stream: json.streams[0], duration: Number(json.format.duration) };
};


const misses: string[] = [];
const check = (file: string, label: string, ok: boolean, value: string) => {
  console.log(`${ok ? "ok  " : "MISS"} ${file.split("/").pop()} ${label}: ${value}`);
  if (!ok) misses.push(`${file} ${label}`);
};
const size = (file: string, limit = Infinity) => {
  const bytes = statSync(file).size;
  check(file, "bytes", bytes > 0 && bytes < limit, `${bytes}`);
};
const video = (file: string, fps: string) => {
  const { stream } = probe(file);
  check(file, "size", stream.width === 1920 && stream.height === 1080, `${stream.width}x${stream.height}`);
  check(file, "fps", stream.r_frame_rate === fps, stream.r_frame_rate);
  const color = [stream.color_space, stream.color_primaries, stream.color_transfer];
  check(file, "color", color.every((c) => c === "bt709"), color.join("/"));
};

size(MASTER);
video(MASTER, "60/1");
size(WEB, UPLOAD_LIMIT);
video(WEB, "30/1");
size(POSTER);
const still = probe(POSTER).stream;
check(POSTER, "size", still.width === 1920 && still.height === 1080, `${still.width}x${still.height}`);
size(GIF, UPLOAD_LIMIT);
const gif = probe(GIF);
check(GIF, "size", gif.stream.width === 800 && gif.stream.height === 450, `${gif.stream.width}x${gif.stream.height}`);
check(GIF, "seconds", gif.duration >= 11 && gif.duration <= 13, gif.duration.toFixed(2));
const scratch = mkdtempSync(join(tmpdir(), "omca-loop-"));
const firstPng = join(scratch, "first.png");
const lastPng = join(scratch, "last.png");
run("ffmpeg", ["-v", "error", "-i", GIF, "-frames:v", "1", firstPng]);
// -update 1 rewrites one image file per decoded frame, leaving the last frame behind.
run("ffmpeg", ["-v", "error", "-i", GIF, "-update", "1", lastPng]);
const differs = !readFileSync(firstPng).equals(readFileSync(lastPng));
rmSync(scratch, { recursive: true });
check(GIF, "last frame differs from first", differs, differs ? "differs" : "identical");

if (misses.length > 0) {
  console.error(`${misses.length} check(s) missed`);
  process.exit(1);
}
console.log("all deliverables checked");
