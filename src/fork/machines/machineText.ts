import { osLabel, type Where } from "./machineLabel";

/**
 * Fork: the label text a surface shows for a path, or undefined when it shows
 * none. Remote paths always carry one; local paths only when `local` is set
 * and a remote machine is connected to tell this computer apart from.
 */
export function whereText(
  where: Where,
  options: { enabled: boolean; local?: boolean },
): string | undefined {
  if (!options.enabled) {
    return undefined;
  }
  if (where.remote) {
    return where.label;
  }
  return options.local && where.show ? where.label : undefined;
}

/** The composer's device chip: what the session's agent is running on. */
export function deviceChipText(label: string, busy: boolean, online: boolean | undefined): string {
  if (online === false) {
    return `${label}, reconnecting`;
  }
  return busy ? `Running on ${label}` : label;
}

/** "tab — project — MonoCode" becomes "tab — project — Vivobook (Linux) — MonoCode". */
export function titleWithMachine(title: string, where: Where, enabled: boolean): string {
  if (!enabled || !where.remote) {
    return title;
  }
  const os = osLabel(where.info?.platform);
  const machine = os ? `${where.name} (${os})` : where.name;
  const suffix = " — MonoCode";
  return title.endsWith(suffix)
    ? `${title.slice(0, -suffix.length)} — ${machine}${suffix}`
    : `${title} — ${machine}`;
}
