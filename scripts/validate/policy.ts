import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Check, type Context, type Outcome, readText, verdict } from "./core.ts";

type Marker = { text: string; label: string };

const POSTURE_DOCS = ["OMCA.md", "skills/omca-setup/SKILL.md"];
const POSTURE_MARKERS: readonly Marker[] = [
  { text: 'teammateMode: "auto"', label: "auto mode" },
  { text: "allowManagedPermissionRulesOnly", label: "managed settings boundary" },
  { text: "sandbox.failIfUnavailable", label: "sandbox fail-closed" },
];
const NON_BYPASSING = /does not auto-allow|never auto-allow|no auto-allow/i;

const HOOK_MODEL_DOC = "OMCA.md";
const HOOK_MODEL_MARKERS: readonly Marker[] = [
  { text: "hooks/register.ts", label: "the mod module" },
  { text: "mcp_tool", label: "the settings hook handler type" },
  { text: "omca_hook", label: "the server hook tool" },
  { text: "tool.check", label: "the guard's mod event" },
  { text: "OMCA_DISABLED_HOOKS", label: "the kill switch" },
  { text: "boulder.json", label: "the plan registry" },
  { text: "verification-evidence.json", label: "the evidence ledger" },
];

function missing(ctx: Context, doc: string, markers: readonly Marker[]): string[] {
  if (!existsSync(join(ctx.root, doc))) return [`${doc} is missing`];
  const source = readText(ctx.root, doc);
  return markers.filter((marker) => !source.includes(marker.text)).map((marker) => `${doc} lacks ${marker.label} marker (${marker.text})`);
}

function policyMarkers(ctx: Context): Outcome {
  const problems = [
    ...POSTURE_DOCS.flatMap((doc) => {
      const absent = missing(ctx, doc, POSTURE_MARKERS);
      const lacksFilterGuidance = existsSync(join(ctx.root, doc)) && !NON_BYPASSING.test(readText(ctx.root, doc));
      return lacksFilterGuidance ? [...absent, `${doc} lacks the non-bypassing permission filter guidance`] : absent;
    }),
    ...missing(ctx, HOOK_MODEL_DOC, HOOK_MODEL_MARKERS),
  ];
  return verdict(problems, `${POSTURE_DOCS.join(" and ")} carry the posture markers, ${HOOK_MODEL_DOC} the hook model markers`);
}

export const checks: readonly Check[] = [{ name: "policy markers", run: policyMarkers }];
