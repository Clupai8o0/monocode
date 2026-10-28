import { useState } from "react";
import { ChevronRight, CornerDownRight } from "../../shared/ui/icons";
import { handoffAge } from "../handoff/handoffModel";
import type {
  ExternalSession,
  ExternalSessionsTarget,
} from "./externalSessionsModel";
import { useExternalSessions } from "./externalSessionsStore";
import { ExternalSessionViewer } from "./ExternalSessionViewer";

const OPEN_KEY = "monocode.fork.elsewhereOpen";

function readOpen(key: string): boolean {
  try {
    const map = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
    return map?.[key] === true;
  } catch {
    return false;
  }
}

function writeOpen(key: string, open: boolean) {
  try {
    const map = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") ?? {};
    if (open) {
      map[key] = true;
    } else {
      delete map[key];
    }
    localStorage.setItem(OPEN_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked: the group just starts collapsed next time.
  }
}

/** Where the sidebar's project keeps its sessions, or none for "~". */
export function elsewhereTarget(
  cwd: string | null | undefined,
  remote?: { machineId?: string; projectId?: string },
): ExternalSessionsTarget | undefined {
  if (!cwd || cwd === "~") {
    return undefined;
  }
  if (remote) {
    return remote.machineId && remote.projectId
      ? { kind: "remote", machineId: remote.machineId, projectId: remote.projectId }
      : undefined;
  }
  return { kind: "local", projectId: cwd, cwd };
}

/** "cx" for the second account, else the agent's own name. */
export function sourceLabel(source: string): string {
  return source === "claude-cx" ? "cx" : source;
}

export function sessionLabel(session: ExternalSession): string {
  if (session.name) {
    return session.name;
  }
  const id = session.id.startsWith("handoff:")
    ? (session.handoffPath ?? session.id.slice(8)).split("/").pop()
    : session.id.slice(0, 8);
  return `${sourceLabel(session.source)} ${id}`;
}

function StateMark({ state }: { state: ExternalSession["state"] }) {
  if (state === "handed-over") {
    return (
      <span className="grid size-4 shrink-0 place-items-center text-accent">
        <CornerDownRight className="size-3" strokeWidth={2} aria-label="Handed over" />
      </span>
    );
  }
  const running = state === "running";
  return (
    <span
      className="grid size-4 shrink-0 place-items-center"
      role="img"
      aria-label={running ? "Running" : "Idle"}
    >
      <span
        className={`size-1.5 rounded-full ${
          running
            ? "bg-emerald-400 motion-safe:animate-[pulse_2s_ease-in-out_infinite]"
            : "bg-content/30"
        }`}
      />
    </span>
  );
}

function Row({
  session,
  now,
  onOpen,
}: {
  session: ExternalSession;
  now: number;
  onOpen: () => void;
}) {
  const at = session.updatedAt ?? session.startedAt;
  return (
    <li className="list-none">
      <button
        type="button"
        data-fork-elsewhere-row=""
        title={session.note || undefined}
        onClick={onOpen}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 text-left text-content/80 hover:bg-content/5 hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        <StateMark state={session.state} />
        <span className="line-clamp-1 min-w-0 flex-1 text-[13px] leading-tight">
          {sessionLabel(session)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-content/45">
          {session.source !== "claude" ? (
            <span>{sourceLabel(session.source)}</span>
          ) : null}
          {session.branch ? (
            <span className="max-w-[88px] truncate">{session.branch}</span>
          ) : null}
          {at ? <span>{handoffAge(at, now)}</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * Fork: under a project's sessions, the ones MonoCode did not start (other
 * terminals, accounts and agents) and recent handoffs. Read-only.
 */
export function ElsewhereGroup({
  target,
  cwd,
}: {
  target: ExternalSessionsTarget | undefined;
  /** The sidebar's project path, where Continue opens a session. */
  cwd: string;
}) {
  const { sessions, supported } = useExternalSessions(target);
  const key = target
    ? target.kind === "local"
      ? target.cwd
      : `${target.machineId}:${target.projectId}`
    : "";
  const [openFor, setOpenFor] = useState<{ key: string; open: boolean }>();
  const open = openFor?.key === key ? openFor.open : readOpen(key);
  // Tied to the project, so switching projects closes the viewer.
  const [viewingFor, setViewing] = useState<{
    key: string;
    session: ExternalSession;
  } | null>(null);
  const viewing = viewingFor?.key === key ? viewingFor.session : null;

  if (!target || !supported || sessions.length === 0) {
    return null;
  }
  const now = Date.now();
  const toggle = () => {
    writeOpen(key, !open);
    setOpenFor({ key, open: !open });
  };
  return (
    <div data-fork-elsewhere="" className="mt-3 px-1 pb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-[12px] font-medium text-content/50 hover:text-content/80"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          strokeWidth={1.75}
        />
        <span>Elsewhere</span>
        <span className="tabular-nums text-content/35">{sessions.length}</span>
      </button>
      {open ? (
        <ul className="flex flex-col gap-px">
          {sessions.map((session) => (
            <Row
              key={session.id}
              session={session}
              now={now}
              onOpen={() => setViewing({ key, session })}
            />
          ))}
        </ul>
      ) : null}
      {viewing ? (
        <ExternalSessionViewer
          target={target}
          session={viewing}
          cwd={cwd}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}
