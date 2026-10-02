const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** True when the id can name a file under `.omca/state/` without leaving its directory. */
export const isSafeSessionId = (id: string): boolean => SAFE_SESSION_ID.test(id);
