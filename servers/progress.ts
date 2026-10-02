export type ProgressUpdate = { message: string; progress?: number; total?: number };
export type Progress = (update: ProgressUpdate) => void;
export type ToolContext = { signal: AbortSignal; progress: Progress };

export const IDLE_CONTEXT: ToolContext = { signal: new AbortController().signal, progress: () => {} };

const PROGRESS_INTERVAL_MS = 250;

type Options = {
  token: string | number;
  signal: AbortSignal;
  send: (params: Record<string, unknown>) => void;
  now?: () => number;
};

/**
 * Turns a tool's updates into `notifications/progress` params, sending at most one per interval.
 * An update without `progress` takes the next integer, since the client needs each value to exceed the last.
 * Nothing is sent once `close` has run or the request is cancelled.
 */
export function createProgress({ token, signal, send, now = performance.now.bind(performance) }: Options): {
  report: Progress;
  close: () => void;
} {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let count = 0;
  let closed = false;
  return {
    report({ message, progress, total }) {
      const at = now();
      if (closed || signal.aborted || at - lastSentAt < PROGRESS_INTERVAL_MS) return;
      lastSentAt = at;
      send({ progressToken: token, progress: progress ?? ++count, ...(total !== undefined && { total }), message });
    },
    close() {
      closed = true;
    },
  };
}
