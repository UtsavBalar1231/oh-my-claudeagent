/** `OMCA_DISABLED_HOOKS` holds hook names separated by commas or whitespace; `all` or `*` disables every hook. */
export function isHookDisabled(list: string | undefined, name: string): boolean {
  const entries = (list ?? "").split(/[\s,]+/);
  return entries.includes(name) || entries.includes("all") || entries.includes("*");
}
