const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * False for a name Windows cannot keep as a file: a device name with or without an extension
 * (`nul`, `COM1.txt`), and a name ending in a dot, which Windows drops.
 */
export const isWindowsSafeName = (name: string): boolean =>
  !name.endsWith(".") && !WINDOWS_DEVICE_NAME.test(name.split(".")[0] ?? "");

/** True when the id can name a file under `.omca/state/` without leaving its directory. */
export const isSafeSessionId = (id: string): boolean => SAFE_SESSION_ID.test(id) && isWindowsSafeName(id);
