import type { Script } from "../../scripts/qa/mock-model.ts";

export const BASH_CALLS = 20;
export const READ_CALLS = 10;
export const FIXTURE_FILE = "/work/project/fixture.txt";
export const STOP_PLAN_PATH = "/work/project/stop-plan.md";
export const STOP_SESSION_ID = "6f1c2a52-8d27-4a34-9c35-0b1d7a9e4c11";

export type SessionName = "a" | "b" | "c" | "d";
export type SessionScenario = { name: SessionName; prompt: string; script: Script };

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const tool = (name: string, input: Record<string, unknown>) => ({ content: [{ type: "tool_use" as const, name, input }] });

export const PLAIN_PROMPT = "Reply with the single word ok.";
export const KEYWORD_PROMPT = "plan this task, then reply with the single word ok.";

export const sessions: SessionScenario[] = [
  { name: "a", prompt: PLAIN_PROMPT, script: { main: [text("ok")], subagent: [] } },
  {
    name: "b",
    prompt: "Run the shell command true twenty times.",
    script: {
      main: [...Array.from({ length: BASH_CALLS }, () => tool("Bash", { command: "true", description: "no-op" })), text("done")],
      subagent: [],
    },
  },
  {
    name: "c",
    prompt: "Read fixture.txt ten times.",
    script: {
      main: [
        ...Array.from({ length: READ_CALLS }, (_, i) => tool("Read", { file_path: FIXTURE_FILE, offset: i * 5 + 1, limit: 5 })),
        text("done"),
      ],
      subagent: [],
    },
  },
  { name: "d", prompt: KEYWORD_PROMPT, script: { main: [text("ok")], subagent: [] } },
];

export type GuardCase = { id: string; command: string; destructive: boolean };

export const guardCases: GuardCase[] = [
  { id: "rm-rf-root", command: "rm -rf /", destructive: true },
  { id: "rm-rf-home", command: "rm -rf ~", destructive: true },
  { id: "git-reset-hard", command: "git reset --hard", destructive: true },
  { id: "git-push-force", command: "git push --force origin main", destructive: true },
  { id: "git-commit-no-verify", command: "git commit --no-verify -m x", destructive: true },
  { id: "rm-rf-build", command: "rm -rf ./build", destructive: false },
  { id: "git-status", command: "git status", destructive: false },
  { id: "ls", command: "ls", destructive: false },
];

export const guardScript = (command: string, retry: boolean): Script => ({
  main: [...Array.from({ length: retry ? 2 : 1 }, () => tool("Bash", { command, description: "guard probe" })), text("done")],
  subagent: [],
});

const STOP_PLAN = "# Plan\n\n- [ ] 1. Write the code\n- [ ] 2. Run the tests\n";

export const stopScript = (armId: string): Script => ({
  main: [
    tool("Write", { file_path: STOP_PLAN_PATH, content: STOP_PLAN }),
    ...(armId === "omca"
      ? [
          tool("mcp__plugin_oh-my-claudeagent_omca__boulder_write", {
            active_plan: STOP_PLAN_PATH,
            plan_name: "stop-gate-probe",
            session_id: STOP_SESSION_ID,
          }),
        ]
      : []),
    text("done"),
  ],
  subagent: [],
});

export const stopExpectedRequests = (armId: string): number => (armId === "omca" ? 3 : 2);
