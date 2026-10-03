// The specialists as agents/*.md declares them: `name` and `model` are copied from each file's
// frontmatter, and render.ts fails when they drift; `role` condenses its `description`.
export const AGENTS = [
  { name: "sisyphus", model: "opus", role: "Runs the approved plan end to end" },
  { name: "prometheus", model: "opus", role: "Interviews you and writes the plan" },
  { name: "metis", model: "opus", role: "Finds the gaps in a draft plan" },
  { name: "momus", model: "opus", role: "Reviews the plan: OKAY or REJECT" },
  { name: "executor", model: "sonnet", role: "Implements one scoped task" },
  { name: "explore", model: "sonnet", role: "Searches the codebase" },
  { name: "librarian", model: "sonnet", role: "Researches docs and open-source code" },
  { name: "oracle", model: "fable", role: "Advises on architecture and hard bugs" },
  { name: "hephaestus", model: "opus", role: "Fixes builds, types and toolchains" },
  { name: "multimodal-looker", model: "opus", role: "Reads screenshots, PDFs and diagrams" },
] as const;

export const UNDERNEATH = ["stop gates", "command guard", "evidence ledger", "structural search", "notepads"] as const;
