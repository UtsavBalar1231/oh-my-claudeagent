import { bundle } from "@remotion/bundler";
import { renderFrames, renderMedia, renderStill, RenderInternals, selectComposition } from "@remotion/renderer";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HoldProps } from "./src/Root.tsx";
import type { LoopProps } from "./src/Loop.tsx";

const here = (path: string): string => new URL(path, import.meta.url).pathname;
const out = (name: string): string => here(`./out/${name}`);

const MASTER = out("omca-demo.mp4");
const POSTER = out("poster.png");
const WEB = out("omca-demo-web.mp4");
const GIF = out("omca-loop.gif");
const LOOP_WEBP = out("omca-loop.webp");
const MARK_WEBP = out("omca-mark.webp");
const BLOG = out("blog");
const FILM = join(BLOG, "omca-film.mp4");
const FILM_POSTER = join(BLOG, "omca-film.poster.webp");
// GitHub's upload limit on a free plan is 10 MB, and the check uses the decimal figure.
const UPLOAD_LIMIT = 10_000_000;
const WEB_CRF = 26;
const WEB_FALLBACK_KBPS = 750;
const KIB = 1024;
const BLOG_LIMIT = 950 * KIB;
const LOOP_WEBP_LIMIT = 480 * KIB;
const MARK_WEBP_LIMIT = 300 * KIB;
// Lowest CRF first, so each blog loop keeps the most quality that fits its budget.
const BLOG_CRFS = [22, 24, 26, 28, 30, 32, 34, 36];
// The README WebP gives way in this order, and its budget never grows: the frame rate, then the Prove hold.
const LOOP_WEBP_STEPS: readonly LoopProps[] = [
  { fps: 15, proveHold: 3 },
  { fps: 12, proveHold: 3 },
  { fps: 10, proveHold: 3 },
  { fps: 10, proveHold: 2 },
];
// Lossy sub-rectangle frames blend onto each other, so error builds up between key frames. Measured at
// 15 fps: quality 75 with img2webp's default key frames gave a 41.3 dB floor in 385 KB, and quality 80
// with a key frame every 4 to 8 frames gave 43.96 dB in 468 KB.
const LOOP_WEBP_ARGS = ["-lossy", "-q", "80", "-m", "6", "-kmin", "4", "-kmax", "8"];
// Every decoded frame must stay this close to the Remotion frame it came from, and the bare stage
// (a strip at each edge, clear of the plane's shadow and the caption) this close to the stage colour.
const MIN_PSNR = 35;
const MAX_STAGE_DEVIATION = 8;
const STAGE_RGB = [200, 193, 181] as const;


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

mkdirSync(BLOG, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "omca-video-"));

// The system img2webp and webpmux: Remotion's ffmpeg carries no WebP muxer.
const tool = (command: string, args: string[]): Buffer => {
  const result = spawnSync(command, args, { maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.toString()}`);
  return result.stdout;
};

const noop = () => {};
const frameFiles = async (id: string, inputProps: Record<string, unknown>, name: string): Promise<string[]> => {
  const composition = await selectComposition({ serveUrl, id, inputProps });
  const outputDir = join(scratch, name);
  await renderFrames({ composition, serveUrl, inputProps, outputDir, imageFormat: "png", onStart: noop, onFrameUpdate: noop });
  return readdirSync(outputDir).filter((file) => file.endsWith(".png")).sort().map((file) => join(outputDir, file));
};

const toWebp = (frames: string[], output: string, ms: number, mode: string[]) =>
  tool("img2webp", ["-loop", "0", ...mode, "-d", String(ms), ...frames, "-o", output]);

const still = async (id: string, output: string, frame: number, imageFormat: "png" | "webp") => {
  const composition = await selectComposition({ serveUrl, id });
  await renderStill({ serveUrl, composition, frame, output, imageFormat });
};
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

await still("Poster", POSTER, 0, "png");
await still("Poster", FILM_POSTER, 0, "webp");

const tags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];
const x264 = (input: string, rate: string[] = []) => ["-y", "-i", input, ...rate, "-c:v", "libx264", "-preset", "slow", "-tune", "animation", "-pix_fmt", "yuv420p", ...tags, "-an"];
const web = x264(MASTER, ["-r", "30"]);
run("ffmpeg", [...web, "-crf", String(WEB_CRF), "-movflags", "+faststart", WEB]);
if (statSync(WEB).size >= UPLOAD_LIMIT) {
  const rate = ["-b:v", `${WEB_FALLBACK_KBPS}k`, "-passlogfile", out("web-pass")];
  run("ffmpeg", [...web, ...rate, "-pass", "1", "-f", "null", "/dev/null"]);
  run("ffmpeg", [...web, ...rate, "-pass", "2", "-movflags", "+faststart", WEB]);
}

copyFileSync(WEB, FILM);

// Each blog loop renders near-lossless, then takes the lowest CRF that fits its budget. Its poster is
// the first hold frame the composition reports in its props, or frame 0 for the mark.
const blogLoops = [
  { name: "task-list", id: "TaskList" },
  { name: "reset-guard", id: "ResetGuard" },
  { name: "omca-mark", id: "Mark" },
] as const;
for (const { name, id } of blogLoops) {
  const composition = await selectComposition({ serveUrl, id: `Blog${id}` });
  const source = join(scratch, `${name}.mp4`);
  await renderMedia({
    serveUrl,
    composition,
    codec: "h264",
    crf: 12,
    imageFormat: "png",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    muted: true,
    outputLocation: source,
    onProgress: progress(name),
  });
  const file = join(BLOG, `${name}.mp4`);
  for (const crf of BLOG_CRFS) {
    run("ffmpeg", [...x264(source), "-crf", String(crf), "-movflags", "+faststart", file]);
    if (statSync(file).size <= BLOG_LIMIT) break;
  }
  const { hold = 0 } = composition.props as Partial<HoldProps>;
  await still(`Blog${id}`, join(BLOG, `${name}.poster.webp`), hold, "webp");
}

// A GIF takes no CRF; the Loop composition's own 15 fps sets the frame rate.
const loop = await selectComposition({ serveUrl, id: "Loop" });
await renderMedia({ serveUrl, composition: loop, codec: "gif", imageFormat: "png", outputLocation: GIF, onProgress: progress("loop") });

let loopSettled: LoopProps | undefined;
let loopFrames: string[] = [];
for (const step of LOOP_WEBP_STEPS) {
  loopSettled = step;
  loopFrames = await frameFiles("Loop", step, `loop-${step.fps}-${step.proveHold}`);
  toWebp(loopFrames, LOOP_WEBP, Math.round(1000 / step.fps), LOOP_WEBP_ARGS);
  console.log(`omca-loop.webp at ${step.fps} fps, ${step.proveHold} s hold: ${statSync(LOOP_WEBP).size} bytes`);
  if (statSync(LOOP_WEBP).size <= LOOP_WEBP_LIMIT) break;
}

// 60 fps frames at 17 ms each; the frames are transparent, and identical neighbours cost almost nothing.
toWebp(await frameFiles("Mark", {}, "mark"), MARK_WEBP, 17, ["-lossless", "-m", "6"]);

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
  check(file, "bytes", bytes > 0 && bytes <= limit, `${bytes}`);
};
const video = (file: string, fps: string, width = 1920, height = 1080) => {
  const { stream } = probe(file);
  check(file, "size", stream.width === width && stream.height === height, `${stream.width}x${stream.height}`);
  check(file, "fps", stream.r_frame_rate === fps, stream.r_frame_rate);
  const color = [stream.color_space, stream.color_primaries, stream.color_transfer];
  check(file, "color", color.every((c) => c === "bt709"), color.join("/"));
};

size(MASTER);
video(MASTER, "60/1");
const demoSeconds = probe(MASTER).duration;
check(MASTER, "seconds", demoSeconds >= 85 && demoSeconds <= 95, demoSeconds.toFixed(2));
size(WEB, UPLOAD_LIMIT);
video(WEB, "30/1");
const dimensions = (file: string, width: number, height: number) => {
  const found = /Canvas size: (\d+) x (\d+)/.exec(tool("webpmux", ["-info", file]).toString());
  check(file, "size", found?.[1] === String(width) && found[2] === String(height), `${found?.[1]}x${found?.[2]}`);
};
const seconds = (file: string, min: number, max: number) => {
  const { duration } = probe(file);
  check(file, "seconds", duration >= min && duration <= max, duration.toFixed(2));
};
// A frame is compared as the PNG file it decodes to; -update 1 rewrites one image per decoded frame, leaving the last.
const lastDiffersFromFirst = (file: string) => {
  const first = join(scratch, "first.png");
  const last = join(scratch, "last.png");
  run("ffmpeg", ["-v", "error", "-y", "-i", file, "-frames:v", "1", first]);
  run("ffmpeg", ["-v", "error", "-y", "-i", file, "-update", "1", last]);
  const differs = !readFileSync(first).equals(readFileSync(last));
  check(file, "last frame differs from first", differs, differs ? "differs" : "identical");
};

size(POSTER);
const poster = probe(POSTER).stream;
check(POSTER, "size", poster.width === 1920 && poster.height === 1080, `${poster.width}x${poster.height}`);
size(FILM, UPLOAD_LIMIT);
video(FILM, "30/1");
size(FILM_POSTER);
dimensions(FILM_POSTER, 1920, 1080);
for (const { name } of blogLoops) {
  const file = join(BLOG, `${name}.mp4`);
  size(file, BLOG_LIMIT);
  video(file, "30/1", 1280, 720);
  size(join(BLOG, `${name}.poster.webp`));
  dimensions(join(BLOG, `${name}.poster.webp`), 1280, 720);
}
seconds(join(BLOG, "task-list.mp4"), 12, 15);
seconds(join(BLOG, "reset-guard.mp4"), 10, 12);
seconds(join(BLOG, "omca-mark.mp4"), 3.9, 4.1);
lastDiffersFromFirst(join(BLOG, "task-list.mp4"));
lastDiffersFromFirst(join(BLOG, "reset-guard.mp4"));
// The mark loops seamlessly, so its last frame is not checked against its first.
size(GIF, UPLOAD_LIMIT);
const gif = probe(GIF);
check(GIF, "size", gif.stream.width === 800 && gif.stream.height === 450, `${gif.stream.width}x${gif.stream.height}`);
check(GIF, "seconds", gif.duration >= 10 && gif.duration <= 12, gif.duration.toFixed(2));
check("Loop", "composition seconds", loop.durationInFrames / loop.fps >= 10 && loop.durationInFrames / loop.fps <= 12, (loop.durationInFrames / loop.fps).toFixed(2));
lastDiffersFromFirst(GIF);

size(LOOP_WEBP, LOOP_WEBP_LIMIT);
dimensions(LOOP_WEBP, 800, 450);
// anim_dump writes one TIFF per animation frame, and merged identical frames make fewer of them than
// the render has, so each rendered frame is compared with the animation frame on screen at its time.
const rgb = (file: string): Buffer => tool("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
const measureLoopWebp = (frames: string[], fps: number) => {
  const dumpDir = join(scratch, "loop-dump");
  mkdirSync(dumpDir);
  tool("anim_dump", ["-folder", dumpDir, "-tiff", LOOP_WEBP]);
  const info = tool("webpmux", ["-info", LOOP_WEBP]).toString().split("\n").filter((line) => /^\s*\d+:/.test(line));
  const starts: number[] = [];
  let at = 0;
  for (const line of info) {
    starts.push(at);
    at += Number(line.trim().split(/\s+/)[6]);
  }
  const dumps = readdirSync(dumpDir).filter((file) => file.endsWith(".tiff")).sort();
  const width = 800;
  const height = 450;
  const decoded = new Map<number, Buffer>();
  let minPsnr = Infinity;
  let maxStage = 0;
  frames.forEach((frame, index) => {
    const shown = starts.findLastIndex((start) => start <= index * Math.round(1000 / fps));
    let pixels = decoded.get(shown);
    if (pixels === undefined) {
      pixels = rgb(join(dumpDir, dumps[shown] ?? ""));
      decoded.set(shown, pixels);
    }
    const source = rgb(frame);
    let squares = 0;
    for (let i = 0; i < source.length; i++) squares += ((source[i] ?? 0) - (pixels[i] ?? 0)) ** 2;
    minPsnr = Math.min(minPsnr, squares === 0 ? Infinity : 10 * Math.log10((255 * 255 * source.length) / squares));
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (y >= 4 && y < 420 && x >= 18 && x < width - 18) continue;
        for (let c = 0; c < 3; c++) maxStage = Math.max(maxStage, Math.abs((pixels[(y * width + x) * 3 + c] ?? 0) - (STAGE_RGB[c] ?? 0)));
      }
  });
  return { minPsnr, maxStage };
};
if (loopSettled !== undefined) {
  const { minPsnr, maxStage } = measureLoopWebp(loopFrames, loopSettled.fps);
  check(LOOP_WEBP, "min PSNR against the rendered frames", minPsnr >= MIN_PSNR, `${minPsnr.toFixed(2)} dB`);
  check(LOOP_WEBP, "max stage deviation from #c8c1b5", maxStage <= MAX_STAGE_DEVIATION, `${maxStage}`);
}
console.log(`omca-loop.webp ended at ${loopSettled?.fps} fps with a ${loopSettled?.proveHold} s Prove hold`);
size(MARK_WEBP, MARK_WEBP_LIMIT);
dimensions(MARK_WEBP, 256, 256);

rmSync(scratch, { recursive: true });
if (misses.length > 0) {
  console.error(`${misses.length} check(s) missed`);
  process.exit(1);
}
console.log("all deliverables checked");
