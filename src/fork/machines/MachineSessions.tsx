import { useState } from "react";
import { useRemoteMachines } from "../../features/connections/model/connections";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import { ChevronRight, Laptop } from "../../shared/ui/icons";
import { Row } from "../externalSessions/ElsewhereGroup";
import type {
  ExternalSession,
  ExternalSessionsTarget,
} from "../externalSessions/externalSessionsModel";
import {
  ALL_PROJECTS,
  liveSessions,
  useExternalSessions,
} from "../externalSessions/externalSessionsStore";
import { ExternalSessionViewer } from "../externalSessions/ExternalSessionViewer";
import { FORK_MACHINE_LABELS } from "./machineLabel";

const CLOSED_KEY = "monocode.fork.machineSessionsClosed";

function readClosed(id: string): boolean {
  try {
    return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "{}")?.[id] === true;
  } catch {
    return false;
  }
}

function writeClosed(id: string, closed: boolean) {
  try {
    const map = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "{}") ?? {};
    if (closed) {
      map[id] = true;
    } else {
      delete map[id];
    }
    localStorage.setItem(CLOSED_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked: the group just starts open next time.
  }
}

function MachineGroup({ machine }: { machine: RemoteMachine })
{
  const target: ExternalSessionsTarget = {
    kind: "remote",
    machineId: machine.id,
    projectId: ALL_PROJECTS,
  };
  const { sessions, supported } = useExternalSessions(target);
  const [closed, setClosed] = useState(() => readClosed(machine.id));
  const [opened, setOpened] = useState<ExternalSession | null>(null);
  // The list's newer copy, so an idle session that starts working goes live.
  const viewing =
    opened && (sessions.find((session) => session.id === opened.id) ?? opened);
  const live = supported ? liveSessions(sessions) : [];
  if (live.length === 0 && !viewing) {
    return null;
  }
  const running = live.filter((session) => session.state === "running").length;
  const now = Date.now();
  return (
    <div data-fork-machine-sessions="">
      {live.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={!closed}
            onClick={() => {
              writeClosed(machine.id, !closed);
              setClosed(!closed);
            }}
            className="flex h-7 w-full items-center gap-1 rounded-md px-2 text-[12px] font-medium text-content/50 hover:text-content/80"
          >
            <ChevronRight
              className={`size-3 shrink-0 transition-transform duration-150 ease-out ${closed ? "" : "rotate-90"}`}
              strokeWidth={1.75}
            />
            <Laptop className="size-3 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
            <span className="min-w-0 truncate">{machine.name}</span>
            <span className="ml-auto shrink-0 tabular-nums text-content/35">
              {running > 0 ? `${running} running` : `${live.length} idle`}
            </span>
          </button>
          {closed ? null : (
            <ul className="flex max-h-44 flex-col gap-px overflow-y-auto">
              {live.map((session) => (
                <Row
                  key={session.id}
                  session={session}
                  now={now}
                  onOpen={() => setOpened(session)}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
      {viewing ? (
        <ExternalSessionViewer
          target={{ ...target, projectId: viewing.projectId }}
          session={viewing}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Fork: in the sidebar, the sessions alive on each connected machine, whichever
 * project is open here. Read-only, like Elsewhere; a row opens its live
 * transcript.
 */
export function MachineSessions()
{
  const { machines } = useRemoteMachines(FORK_MACHINE_LABELS);
  if (!FORK_MACHINE_LABELS || machines.length === 0) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-col gap-1 px-2 pb-1 empty:hidden">
      {machines.map((machine) => (
        <MachineGroup key={machine.id} machine={machine} />
      ))}
    </div>
  );
}
