import { AbsoluteFill } from "remotion";
import { color, mono, toFrames } from "../theme.ts";
import { Canvas } from "./shot.tsx";

const LENGTH = 10;

export const installPlan = (fps: number) => ({ duration: toFrames(LENGTH, fps) });

const line = { fontFamily: mono, fontSize: 30, textAlign: "center" } as const;

export const Install = () => (
  <Canvas>
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 28 }}>
      <div style={{ ...line, fontSize: 56, fontWeight: 600, color: color.title }}>oh-my-claudeagent</div>
      <div style={{ ...line, color: color.title }}>claude plugin install oh-my-claudeagent --marketplace UtsavBalar1231/oh-my-claudeagent</div>
      <div style={{ ...line, color: color.title }}>github.com/UtsavBalar1231/oh-my-claudeagent</div>
      <div style={{ ...line, color: color.caption }}>Real Claude Code sessions. Model replies are scripted.</div>
    </AbsoluteFill>
  </Canvas>
);
