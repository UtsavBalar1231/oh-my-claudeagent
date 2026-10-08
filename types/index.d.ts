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
          costUsd: number | null;
          status: "running" | "idle" | "waiting" | "pending" | "answer" | "aborted" | "refusal" | "error" | "gone";
          teammate: boolean;
          task?: number;
        };
      };
      lanes: {
        readonly [agentId: string]: {
          prompt: string;
          calls: number;
          tool: { name: string; detail: string } | null;
          output: string;
          result: string;
        };
      };
      nextActions: readonly {
        kind: "log-evidence" | "start-work" | "final-verification" | "review";
        label: string;
        prompt: string;
      }[];
      band: {
        plan: {
          name: string;
          path: string;
          done: number;
          total: number;
          next: { n: number; title: string } | null;
        } | null;
        verification: { command: string; at: number; isLogged: boolean } | null;
        proof?: { proven: number; unproven: number; failed: number };
        error: string | null;
        readAt: number;
      };
      pane: {
        tab: "agents" | "plan" | "evidence" | "notepad" | "stats" | "doctor";
        notepad: {
          planName: string;
          bound: string | null;
          plans: readonly string[];
          sections: readonly {
            name: "learnings" | "issues" | "decisions" | "problems";
            text: string;
          }[];
        } | null;
        plans: {
          dir: string;
          files: readonly { name: string; path: string; mtimeMs: number }[];
        } | null;
        errors: { notepad: string | null; plans: string | null };
        auto: "pending" | "opened" | "declined";
        readAt: number;
      };
      ledger: {
        entries: readonly {
          type: "build" | "test" | "lint" | "manual" | "final_verification";
          command: string;
          exitCode: number;
          at: number;
          snippet: string;
          verifiedBy: string | null;
          planSha: string;
        }[];
        plan: { name: string; sha: string } | { name: string; error: string } | null;
        error: string | null;
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
          unpriced: number;
          outcomes: { running: number; completed: number; aborted: number; empty: number };
          evidenceRate: number;
        }[];
        turns: readonly { agentType: string; tokens: number }[];
        sessions: number;
        skipped: number;
        pricingAsOf: string;
        error: string | null;
        readAt: number;
      };
      agentPage: { id: string | null };
      pages: {
        readonly [agentId: string]: {
          brief: string;
          source: "messages" | "prompt";
          calls: { tool: string; summary: string; ok: boolean | null; durationMs: number | null }[];
          reply: string;
        };
      };
      costSample: { turnId: string; usd: number | null; at: number };
      doctor: {
        isRunning: boolean;
        checks: readonly {
          id: string;
          label: string;
          level: "ok" | "warn" | "fail" | "info";
          detail: string;
          fix?: "add-refresh-interval";
          prompt?: string;
        }[];
        applied: {
          fix: "add-refresh-interval";
          path: string;
          backupPath: string;
          diff: string;
        } | null;
        error: string | null;
        ranAt: number;
      };
    };
  }
}
