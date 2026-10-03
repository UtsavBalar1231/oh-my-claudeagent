import type { FC } from "react";
import { AbsoluteFill, Freeze, Img, Sequence, Series, staticFile, useVideoConfig } from "remotion";
import heroManifest from "../public/placeholder/hero.json";
import { Callout } from "./components/Callout.tsx";
import { Camera, type CameraKeyframe } from "./components/Camera.tsx";
import { Caption } from "./components/Caption.tsx";
import { ChapterTag } from "./components/ChapterTag.tsx";
import { CornerLabel } from "./components/CornerLabel.tsx";
import { EndCard } from "./components/EndCard.tsx";
import { KeyCaps } from "./components/KeyCaps.tsx";
import { LowerThird } from "./components/LowerThird.tsx";
import { StatChip } from "./components/StatChip.tsx";
import { Typewriter } from "./components/Typewriter.tsx";
import { Window } from "./components/Window.tsx";
import { type ClipManifest, markFrame, target, targetRect } from "./footage.ts";
import { color, SAFE, time, toFrames } from "./theme.ts";

// The placeholder clip is the README hero still with a footage frame counter burned in, so the
// stills show where playbackRate and Freeze land; its cell grid was measured from the PNG.
const HERO: ClipManifest = heroManifest;
const HERO_SRC = "placeholder/hero.mp4";
const TASK_ROW = targetRect(HERO, target(HERO, "task-row"));
const WIDE = { x: HERO.width / 2, y: HERO.height / 2, zoom: 1 };
const AIM = { x: TASK_ROW.x + TASK_ROW.width / 2, y: TASK_ROW.y + TASK_ROW.height / 2, zoom: 1.6 };
const PANEL = { x: 240, y: 150, width: 1440, height: 720 } as const;
const HOLD_AT = 0.5;
const PUSH_AT = 0.33;

const REEL = { camera: 3, hold: 3, frozen: 1.5, text: 4, keys: 2.5, typing: 2.5, end: 7 } as const;
export const REEL_SECONDS = Object.values(REEL).reduce((sum, seconds) => sum + seconds, 0);
export type ReelProps = { fps: number };

const Backdrop = () => (
  <Window box={PANEL}>
    <Img src={staticFile("placeholder/plan.png")} style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.35 }} />
  </Window>
);

const SafeArea = () => (
  <div
    style={{
      position: "absolute",
      left: SAFE.x,
      right: SAFE.x,
      top: SAFE.top,
      bottom: SAFE.bottom,
      border: `1px dashed ${color.accent}`,
      opacity: 0.35,
    }}
  />
);

export const Reel: FC<ReelProps> = () => {
  const { fps } = useVideoConfig();
  const f = (seconds: number) => toFrames(seconds, fps);
  const push: CameraKeyframe[] = [
    { frame: 0, ...WIDE },
    { frame: f(PUSH_AT), ...WIDE },
    { frame: f(PUSH_AT + time.camera), ...AIM },
  ];
  return (
    <AbsoluteFill style={{ background: color.canvas }}>
      <Series>
        <Series.Sequence durationInFrames={f(REEL.camera)} premountFor={fps}>
          <Camera src={HERO_SRC} footage={HERO} keyframes={push} durationInFrames={f(REEL.camera)} />
          <CornerLabel />
        </Series.Sequence>
        <Series.Sequence durationInFrames={f(REEL.hold)} premountFor={fps}>
          <Camera
            src={HERO_SRC}
            footage={HERO}
            keyframes={[{ frame: 0, ...AIM }]}
            durationInFrames={f(REEL.hold)}
            trimBefore={markFrame(HERO, "hold", fps)}
            playbackRate={2}
            freeze={{ frame: f(HOLD_AT), active: (frame) => frame >= f(HOLD_AT) }}
          >
            <Sequence from={f(HOLD_AT)} premountFor={fps}>
              <Callout target={TASK_ROW} label="Not proven yet" />
            </Sequence>
          </Camera>
          <CornerLabel />
        </Series.Sequence>
        <Series.Sequence durationInFrames={f(REEL.frozen)} premountFor={fps}>
          <Freeze frame={f(1)}>
            <Camera src={HERO_SRC} footage={HERO} keyframes={push} durationInFrames={f(REEL.frozen)} />
          </Freeze>
          <CornerLabel />
        </Series.Sequence>
        <Series.Sequence durationInFrames={f(REEL.text)} premountFor={fps}>
          <Backdrop />
          <ChapterTag index={1} label="Plan" />
          <CornerLabel />
          <Sequence from={f(0.33)} durationInFrames={f(3.33)} premountFor={fps}>
            <Caption text="It plans with you first." placement="center" />
          </Sequence>
          <Sequence from={f(0.67)} durationInFrames={f(3.17)} premountFor={fps}>
            <LowerThird items={["interview", "gap check", "review"]} />
          </Sequence>
          <Sequence from={f(1)} durationInFrames={f(2.83)} premountFor={fps}>
            <StatChip value="5 of 5" label="test commands blocked" source="Measured 2026-10-03 · Claude Code 2.1.288" />
          </Sequence>
        </Series.Sequence>
        <Series.Sequence durationInFrames={f(REEL.keys)} premountFor={fps}>
          <Backdrop />
          <KeyCaps keys={["Shift", "Tab"]} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={f(REEL.typing)} premountFor={fps}>
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
            <Typewriter text="/oh-my-claudeagent:plan add a checkout flow" startAt={0.17} size={44} />
          </AbsoluteFill>
        </Series.Sequence>
        <Series.Sequence durationInFrames={f(REEL.end)} premountFor={fps}>
          <EndCard line="Claude Code, with receipts." />
        </Series.Sequence>
      </Series>
      <SafeArea />
    </AbsoluteFill>
  );
};
