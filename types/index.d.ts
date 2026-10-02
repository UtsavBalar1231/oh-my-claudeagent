declare module "claude-code" {
  interface PluginState {
    "oh-my-claudeagent": {
      agents: {
        readonly [agentId: string]: {
          type: string;
          description: string;
          model: string;
          effort: "low" | "medium" | "high" | "xhigh" | "max" | number | null;
          startedAt: number;
          endedAt: number | null;
          inputTokens: number;
          outputTokens: number;
          status: "running" | "answer" | "aborted" | "refusal" | "error" | "gone";
        };
      };
      routes: {
        readonly [agentId: string]: {
          effort: "low" | "medium" | "high" | "xhigh" | "max" | null;
          model: "sonnet" | "opus" | "fable" | null;
        };
      };
      nextActions: readonly {
        kind: "log-evidence" | "start-work" | "final-verification" | "review";
        label: string;
        prompt: string;
      }[];
      band: {
        plan: { name: string; path: string; done: number; total: number } | null;
        verification: { command: string; at: number; isLogged: boolean } | null;
        error: string | null;
        readAt: number;
      };
      pane: {
        tab: "agents" | "plan" | "evidence" | "notepad" | "feedback" | "stats" | "doctor";
        evidence: readonly {
          type: "build" | "test" | "lint" | "manual" | "final_verification";
          command: string;
          exitCode: number;
          at: number;
          snippet: string;
          verifiedBy: string | null;
        }[];
        notepad: {
          planName: string;
          sections: readonly {
            name: "learnings" | "issues" | "decisions" | "problems";
            text: string;
          }[];
        } | null;
        error: string | null;
        readAt: number;
      };
      status: {
        verification: { command: string; at: number } | null;
        isEvidenceLogged: boolean;
        lastHookAt: number | null;
        readAt: number;
      };
      plan:
        | {
            path: string;
            title: string;
            pages: readonly {
              title: string;
              level: number;
              body: string;
              task?: { n: number; done: boolean };
            }[];
            done: number;
            total: number;
            readAt: number;
          }
        | { path: string; error: string; readAt: number };
      stats: {
        rows: readonly {
          agentType: string;
          count: number;
          medianDurationMs: number;
          inputTokens: number;
          outputTokens: number;
          estimatedCostUsd: number;
          outcomes: { running: number; completed: number; aborted: number; empty: number };
          evidenceRate: number;
        }[];
        sessions: number;
        skipped: number;
        pricingAsOf: string;
        error: string | null;
        readAt: number;
      };
      costSample: { turnId: string; usd: number | null; at: number };
      doctor: {
        isRunning: boolean;
        checks: readonly {
          id: string;
          label: string;
          level: "ok" | "warn" | "fail" | "info";
          detail: string;
          fix?: "remove-setup-block" | "add-refresh-interval";
        }[];
        applied: {
          fix: "remove-setup-block" | "add-refresh-interval";
          path: string;
          backupPath: string;
          diff: string;
        } | null;
        error: string | null;
        ranAt: number;
      };
      dialogs: {
        readonly [signature: string]: { decision: "run" | "refuse"; at: number };
      };
    };
  }
}
