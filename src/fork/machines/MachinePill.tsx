import { useRemoteMachineOnline } from "../../features/connections/model/connections";
import {
  FORK_MACHINE_LABELS,
  knownMachineFor,
  machineDetail,
  useMachineInfo,
  useWhere,
} from "./machineLabel";
import { titleWithMachine, whereText } from "./machineText";

/**
 * Fork: a small tinted pill naming the machine a path is on. Accent tint for
 * a remote machine, the quiet fill for this computer (only with `local`, and
 * only while a remote machine is connected). Renders nothing under vitest.
 */
export function MachinePill({
  path,
  local = false,
  status = false,
  title,
  className = "",
}: {
  path: string | undefined;
  local?: boolean;
  /** Put the connection state in the tooltip. */
  status?: boolean;
  title?: string;
  className?: string;
}) {
  const where = useWhere(path);
  const text = whereText(where, { enabled: FORK_MACHINE_LABELS, local });
  const online = useRemoteMachineOnline(where.remote ? where.machine?.id : undefined);
  if (!text) {
    return null;
  }
  const tone = where.remote ? "bg-accent/15 text-accent" : "bg-content/8 text-content/60";
  return (
    <span
      data-machine-pill
      title={title ?? (status && where.remote ? `${text} (${connectionText(where.machine, online)})` : text)}
      className={`inline-flex max-w-48 shrink-0 items-center self-center rounded-full px-2 py-px text-[11px] font-medium leading-4 ${tone} ${className}`}
    >
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

/** The label text for a path, or undefined (see `whereText`). */
export function useMachineText(path: string | undefined, local = false): string | undefined {
  return whereText(useWhere(path), { enabled: FORK_MACHINE_LABELS, local });
}

/** The window title with the remote machine named in it. */
export function useMachineTitle(path: string | undefined, title: string): string {
  return titleWithMachine(title, useWhere(path), FORK_MACHINE_LABELS);
}

function connectionText(machine: unknown, online: boolean | undefined): string {
  if (!machine) {
    return "Not connected on this computer";
  }
  return online === undefined ? "Connecting" : online ? "Connected" : "Reconnecting";
}

/** A terminal tab's tooltip on a remote machine: "Terminal on Vivobook · Linux". */
export function terminalMachineTooltip(cwd: string | undefined): string | undefined {
  const known = FORK_MACHINE_LABELS && cwd ? knownMachineFor(cwd) : undefined;
  return known ? `Terminal on ${known.label}` : undefined;
}

/** Settings line under a machine: "Linux · Fedora Linux 44 · host: fedora". */
export function MachineDetailLine({ machineId, name }: { machineId: string; name: string }) {
  const info = useMachineInfo(FORK_MACHINE_LABELS ? machineId : undefined);
  const text = FORK_MACHINE_LABELS ? machineDetail(info, name) : undefined;
  return text ? <div className="mt-1 truncate text-[12px] text-content/45">{text}</div> : null;
}

/** Phone catalog fields for a `remote://` project; none for a local one. */
export function catalogMachineFields(
  path: string,
): { machineName: string; machinePlatform?: string } | Record<string, never> {
  const known = path.startsWith("remote://") ? knownMachineFor(path) : undefined;
  return known ? { machineName: known.name, machinePlatform: known.platform } : {};
}
