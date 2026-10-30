import { useRemoteMachineOnline } from "../../features/connections/model/connections";
import { Laptop } from "../../shared/ui/icons";
import { FORK_MACHINE_LABELS, useWhere } from "./machineLabel";
import { deviceChipText, whereText } from "./machineText";

/**
 * Fork: a chip on the composer's top edge naming the device the session's
 * agent runs on, accent for another machine, quiet for this one (and only
 * while another is connected). The dot breathes while the agent works and
 * turns amber while the machine is out of reach. Renders nothing under vitest.
 */
export function ComposerDevice({ cwd, busy }: { cwd: string | undefined; busy: boolean })
{
  const where = useWhere(cwd);
  const label = whereText(where, { enabled: FORK_MACHINE_LABELS, local: true });
  const online = useRemoteMachineOnline(where.remote ? where.machine?.id : undefined);
  if (!label) {
    return null;
  }
  const lost = where.remote && online === false;
  const text = deviceChipText(label, busy, where.remote ? online : undefined);
  return (
    <span
      data-composer-device={where.remote ? "remote" : "local"}
      title={text}
      className={`pointer-events-none absolute -top-2.5 right-3 z-30 inline-flex max-w-[60%] items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 shadow-sm ring-1 backdrop-blur-xl ${
        where.remote
          ? "bg-background-base/90 text-accent ring-accent/40"
          : "bg-background-base/90 text-content/60 ring-content/10"
      }`}
    >
      <Laptop className="size-3 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 truncate">{text}</span>
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${
          lost
            ? "bg-amber-400"
            : busy
              ? "bg-emerald-400 motion-safe:animate-[pulse_2s_ease-in-out_infinite]"
              : where.remote
                ? "bg-accent/70"
                : "bg-content/30"
        }`}
      />
    </span>
  );
}
