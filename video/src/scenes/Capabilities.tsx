import { AGENTS, UNDERNEATH } from "../agents.ts";
import { color, mono, time, toFrames, useMotion } from "../theme.ts";
import { useVideoConfig } from "remotion";
import { beatLength, Canvas, Chapter } from "./shot.tsx";

const ROWS_AT = 0.3;
const UNDERNEATH_AT = 3.2;

export const capabilitiesPlan = (fps: number) => ({ duration: toFrames(beatLength(7), fps) });

const rise = (p: number) => ({ opacity: p, translate: `0 ${(1 - p) * 8}px` });

export const Capabilities = () => {
  const { enter, leave } = useMotion();
  const { fps } = useVideoConfig();
  return (
    <Canvas>
      <Chapter name="Under it" beatDuration={capabilitiesPlan(fps).duration} enters leaves />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 44,
          fontFamily: mono,
          opacity: 1 - leave(),
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "auto auto auto", columnGap: 40, rowGap: 10, fontSize: 30, lineHeight: 1.25 }}>
          {AGENTS.flatMap((agent, i) => {
            const shown = rise(enter(ROWS_AT + i * time.stagger * 2));
            return [
              <div key={`${agent.name}-name`} style={{ color: color.accent, fontWeight: 600, ...shown }}>
                {agent.name}
              </div>,
              <div key={`${agent.name}-model`} style={{ color: color.muted, ...shown }}>
                {agent.model}
              </div>,
              <div key={`${agent.name}-role`} style={{ color: color.text, ...shown }}>
                {agent.role}
              </div>,
            ];
          })}
        </div>
        <div style={{ display: "flex", gap: "0.7em", fontSize: 30, letterSpacing: "0.02em", color: color.text, ...rise(enter(UNDERNEATH_AT)) }}>
          {UNDERNEATH.map((item, i) => (
            <span key={item}>
              {i === 0 ? null : <span style={{ color: color.accent, marginRight: "0.7em" }}>·</span>}
              {item}
            </span>
          ))}
        </div>
      </div>
    </Canvas>
  );
};
