declare module "claude-code" {
  interface PluginState {
    "oh-my-claudeagent": {
      agents: {
        readonly [agentId: string]: {
          type: string;
          forkOf?: string;
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
          evidenceLogged: boolean;
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
        kind: "log-evidence" | "task-list";
        label: string;
        prompt: string;
      }[];
      band: {
        verification: { command: string; at: number; isLogged: boolean } | null;
        error: string | null;
        readAt: number;
      };
      pane: {
        tab: "agents" | "evidence" | "notepad" | "stats" | "doctor";
        notepad: {
          planName: string;
          plans: readonly string[];
          sections: readonly {
            name: "learnings" | "issues" | "decisions" | "problems";
            text: string;
          }[];
        } | null;
        errors: { notepad: string | null };
        readAt: number;
      };
      tasks: {
        tasks: readonly {
          id: string;
          subject: string;
          description: string;
          activeForm: string;
          status: "pending" | "in_progress" | "completed";
          owner: string;
          blocks: readonly string[];
          blockedBy: readonly string[];
          run: string;
          isFinal: boolean;
          blockedReason: string;
          details: readonly { name: string; text: string }[];
        }[];
        hasTools: boolean;
        isCleared: boolean;
        error: string | null;
        list: string;
      };
      placedRows: {
        readonly [id: string]: {
          summary: {
            name: string;
            done: number;
            total: number;
            running: readonly string[];
            blocked: readonly string[];
            isOpen: boolean;
          };
          changes: {
            created: number;
            completed: readonly string[];
            started: readonly string[];
            blocked: readonly string[];
            isFinalDone: boolean;
          };
        };
      };
      ledger: {
        entries: readonly {
          type: "build" | "test" | "lint" | "manual" | "final_verification";
          command: string;
          exitCode: number;
          at: number;
          snippet: string;
          verifiedBy: string | null;
          taskId: string;
          run: string;
          taskList: string;
          tree: string;
        }[];
        error: string | null;
        readAt: number;
      };
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
      notices: {
        readonly [agentId: string]: {
          type: string;
          description: string;
          status: "answer" | "aborted" | "refusal" | "error" | "gone";
          durationMs: number | null;
          calls: number;
          tokens: number;
          result: string;
        };
      };
      turns: readonly {
        turnId: string;
        startedAt: number;
        endedAt: number;
        tokens: { input: number; output: number } | null;
        costUsd: number | null;
        receipt: { command: string; at: number; isLogged: boolean } | null;
        waiting: readonly string[];
      }[];
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
