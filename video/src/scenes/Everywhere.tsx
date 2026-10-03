import { spring } from "remotion";
import { Caption } from "../components/Caption.tsx";
import { color, mono, springs, time, toFrames, useMotion } from "../theme.ts";
import { beatLength, Canvas } from "./shot.tsx";

// GitHub Actions run 37150075076 (2026-10-03): 13 of 13 jobs green on the three hosted runners.
const SYSTEMS = [
  { name: "Linux", runner: "ubuntu-latest" },
  { name: "macOS", runner: "macos-latest" },
  { name: "Windows", runner: "windows-latest" },
] as const;
const CHECKS = ["Plugin validation", "Type checks and specs", "OpenCode adapter", "Real session"] as const;
const SOURCE = "GitHub Actions · run 37150075076 · 2026-10-03";
const SUB = "A real Claude Code session on each, every commit.";
const GRID_AT = 0.5;
const NAME_WIDTH = 440;
const COLUMN_WIDTH = 270;
const ROW_HEIGHT = 72;

export const everywherePlan = (fps: number) => ({ duration: toFrames(beatLength(6), fps) });

const Check = () => (
  <svg width={40} height={40} viewBox="0 0 24 24" aria-hidden>
    <path d="M4 12.5l5 5L20 6.5" fill="none" stroke={color.green} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Everywhere = () => {
  const { frame, fps, f, enter, leave } = useMotion();
  const column = (i: number) => spring({ frame: frame - f(GRID_AT + i * time.stagger), fps, config: springs.calm });
  const rise = (p: number) => ({ opacity: Math.min(1, p), translate: `0 ${(1 - p) * 16}px` });
  return (
    <Canvas>
      <Caption text="Linux, macOS and Windows." placement="top" />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 250,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 36,
          fontFamily: mono,
          opacity: 1 - leave(),
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `${NAME_WIDTH}px repeat(${SYSTEMS.length}, ${COLUMN_WIDTH}px)`,
            gridAutoRows: ROW_HEIGHT,
            alignItems: "center",
            padding: "20px 36px",
            borderRadius: 16,
            background: color.panel,
            border: `1px solid ${color.frameBorder}`,
            fontSize: 32,
            color: color.text,
            ...rise(column(0)),
          }}
        >
          <div />
          {SYSTEMS.map((system, i) => (
            <div key={system.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.1, ...rise(column(i + 1)) }}>
              <span style={{ fontWeight: 600 }}>{system.name}</span>
              <span style={{ fontSize: 28, color: color.muted }}>{system.runner}</span>
            </div>
          ))}
          {CHECKS.flatMap((check) => [
            <div key={check} style={{ color: color.muted }}>
              {check}
            </div>,
            ...SYSTEMS.map((system, i) => (
              <div key={`${check}-${system.name}`} style={{ display: "flex", justifyContent: "center", ...rise(column(i + 1)) }}>
                <Check />
              </div>
            )),
          ])}
        </div>
        <div style={{ fontSize: 32, letterSpacing: "0.02em", color: color.text, ...rise(enter(GRID_AT + 0.5)) }}>{SUB}</div>
        <div style={{ fontSize: 28, letterSpacing: "0.02em", color: color.muted, ...rise(enter(GRID_AT + 0.6)) }}>{SOURCE}</div>
      </div>
    </Canvas>
  );
};
