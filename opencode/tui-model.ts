export const tabs = ["Overview", "Plan", "Agents", "Evidence", "Notepad", "Doctor"] as const;
export type Tab = typeof tabs[number];

export function commandTab(input = ""): Tab | undefined {
  const name = input.trim().replace(/^\/omca(?:\s+|$)/i, "").toLowerCase();
  return name === "" ? "Overview" : tabs.find((tab) => tab.toLowerCase() === name);
}

export function plain(value: string): string {
  // eslint-disable-next-line no-control-regex -- Remote text must not emit terminal controls.
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export interface Target {
  sessionID: string;
  location: { directory: string; workspaceID?: string };
}

export function targetKey(target: Target): string {
  return JSON.stringify([target.sessionID, target.location.directory, target.location.workspaceID ?? null]);
}

export interface ReadState<T> {
  key: string;
  phase: "loading" | "ready" | "error";
  stale: boolean;
  value: T | undefined;
  error: string | undefined;
}

export function snapshotReader<T>(fetch: (target: Target, signal: AbortSignal) => Promise<T>, publish: (state: ReadState<T> | undefined) => void) {
  let selected: Target | undefined;
  let active: AbortController | undefined;
  let queued = false;
  let disposed = false;
  let state: ReadState<T> | undefined;

  function emit(next: ReadState<T> | undefined) {
    state = next;
    publish(next);
  }

  async function drain() {
    if (active || disposed || !selected) return;
    const request = new AbortController();
    active = request;
    queued = false;
    const target = selected;
    try {
      const value = await fetch(target, request.signal);
      if (active === request) {
        emit({ key: targetKey(target), phase: "ready", stale: queued, value, error: undefined });
      }
    } catch (error) {
      if (active === request) {
        emit({ key: targetKey(target), phase: "error", stale: true, value: state?.value, error: plain(error instanceof Error ? error.message : String(error)) });
      }
    } finally {
      if (active === request) {
        active = undefined;
        if (queued && !disposed) void drain();
      }
    }
  }

  return {
    select(target: Target | undefined) {
      if (disposed || (target && selected && targetKey(target) === targetKey(selected))) return;
      const previous = active;
      active = undefined;
      selected = target && {
        sessionID: target.sessionID,
        location: {
          directory: target.location.directory,
          ...(target.location.workspaceID === undefined ? {} : { workspaceID: target.location.workspaceID }),
        },
      };
      queued = !!target;
      emit(target ? { key: targetKey(target), phase: "loading", stale: false, value: undefined, error: undefined } : undefined);
      previous?.abort();
      void drain();
    },
    refresh() {
      if (disposed || !selected) return;
      queued = true;
      if (state) emit({ ...state, stale: !!state.value });
      void drain();
    },
    dispose() {
      disposed = true;
      selected = undefined;
      queued = false;
      const previous = active;
      active = undefined;
      previous?.abort();
    },
  };
}
