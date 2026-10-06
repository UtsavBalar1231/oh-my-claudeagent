// The specialists as agents/*.md declares them: `name` and `model` are copied from each file's
// frontmatter, and render.ts fails when they drift; `role` condenses its `description`.
export const AGENTS = [
  { name: "orchestrator", model: "opus", role: "Runs the approved plan end to end" },
  { name: "planner", model: "opus", role: "Interviews you and writes the plan" },
  { name: "analyzer", model: "opus", role: "Finds the gaps in a draft plan" },
  { name: "reviewer", model: "opus", role: "Reviews the plan: OKAY or REJECT" },
  { name: "executor", model: "sonnet", role: "Implements one scoped task" },
  { name: "explorer", model: "sonnet", role: "Searches the codebase" },
  { name: "researcher", model: "sonnet", role: "Researches docs and open-source code" },
  { name: "architect", model: "fable", role: "Advises on architecture and hard bugs" },
  { name: "build-fixer", model: "opus", role: "Fixes builds, types and toolchains" },
  { name: "viewer", model: "opus", role: "Reads screenshots, PDFs and diagrams" },
] as const;

export const UNDERNEATH = ["stop gates", "command guard", "evidence ledger", "structural search", "notepads"] as const;
