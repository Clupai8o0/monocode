import {
  formatGb,
  gateLine,
  machineLine,
  machineStrain,
  roundTripLine,
  sessionActivity,
  sessionRows,
  shortTime,
  sparkColumns,
  type SessionLag,
} from "./labHealth";
import type { LabHealth, LabHealthPoint } from "./labProtocol";
import { getHostHealth, retryHealth, useLabHealth } from "./labHealthStore";
import type { LabHost } from "./labStore";

/**
 * Fork: the machine's health inside the Home lab popover: two pixel sparklines,
 * one row per working session, and plain words when something lags.
 */

const COLUMNS = 60;
const ROWS = 12;
/** One column and one row, in screen pixels. */
const CELL = 2;

function Spark({
  label,
  value,
  points,
  read,
  at,
}: {
  label: string;
  value: string;
  points: readonly LabHealthPoint[];
  read: (point: LabHealthPoint) => number | null;
  at: number;
}) {
  const columns = sparkColumns(points, read, at, COLUMNS, ROWS);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-baseline gap-1.5">
        <span className="font-medium text-content">{label}</span>
        <span className="truncate tabular-nums text-content/55">{value}</span>
      </div>
      <svg
        role="img"
        aria-label={`${label} over the last 10 minutes, now ${value}`}
        width={COLUMNS * CELL}
        height={ROWS * CELL}
        viewBox={`0 0 ${COLUMNS} ${ROWS}`}
        shapeRendering="crispEdges"
        className="text-accent"
        fill="currentColor"
      >
        {columns.map((height, index) =>
          height ? <rect key={index} x={index} y={ROWS - height} width={1} height={height} /> : null,
        )}
      </svg>
    </div>
  );
}

function lagWord(lag: SessionLag): string | null {
  return lag === "no-response" ? "no response" : lag === "slow" ? "slow" : null;
}

function HealthBody({ health, roundTripMs }: { health: LabHealth; roundTripMs: number | null }) {
  const strain = machineStrain(health);
  const { rows, idle } = sessionRows(health);
  const gate = gateLine(health);
  const trip = roundTripLine(roundTripMs);
  const cpu = health.cpu.percent;
  const used = (point: LabHealthPoint) => 100 - point.memoryAvailable;
  return (
    <>
      {strain.length ? (
        <p role="alert" className="text-[11px] font-medium leading-snug text-amber-500">
          Machine strained: {strain.join(", ")}.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <Spark
          label="CPU"
          value={cpu === null ? "…" : `${Math.round(cpu)}%`}
          points={health.history}
          read={(point) => point.cpu}
          at={health.at}
        />
        <Spark
          label="Memory"
          value={`${formatGb(health.memory.availableMb)} free`}
          points={health.history}
          read={used}
          at={health.at}
        />
      </div>
      <p className="text-[11px] leading-snug text-content/55">
        {[machineLine(health), gate, trip].filter(Boolean).join(" · ")}
      </p>
      {rows.length ? (
        <ul aria-label="Working sessions" className="flex flex-col gap-1">
          {rows.map(({ session, lag }) => {
            const word = lagWord(lag);
            return (
              <li
                key={session.sessionId}
                className="flex min-w-0 items-baseline gap-1.5 text-[11px] tabular-nums text-content/70"
              >
                <span className="min-w-0 truncate font-medium text-content" title={session.name}>
                  {session.name}
                </span>
                <span className="shrink-0">· {sessionActivity(session)}</span>
                {session.quietMs !== null ? (
                  <span className="shrink-0">· {shortTime(session.quietMs)} ago</span>
                ) : null}
                {word ? (
                  <span
                    className={`ml-auto shrink-0 font-medium ${
                      lag === "no-response" ? "text-red-500" : "text-amber-500"
                    }`}
                  >
                    {word}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="text-[11px] leading-snug text-content/45">
        {rows.length ? "" : "No session is working. "}
        {idle > 0 ? `${idle} idle.` : ""}
      </p>
    </>
  );
}

export function LabHealthSection({ hosts, heading }: { hosts: readonly LabHost[]; heading: boolean }) {
  const all = useLabHealth(true);
  const offering = hosts.filter((host) => host.health);
  if (!offering.length) {
    return null;
  }
  return (
    <>
      {offering.map((host) => {
        const id = host.machine.id;
        const entry = getHostHealth(all, id);
        return (
          <section
            key={id}
            data-fork-lab-health=""
            aria-label={`${host.machine.name} health`}
            className="flex flex-col gap-2"
          >
            <span className="font-medium text-content">
              {heading ? `${host.machine.name} health` : "Health"}
            </span>
            {entry.unreachable ? (
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 text-[11px] leading-snug text-amber-500">
                  Can't reach {host.machine.name} ({entry.error.replace(/\.$/, "")}), so this has stopped updating.
                </p>
                <button
                  type="button"
                  className="rounded bg-content/6 px-1.5 py-0.5 text-[11px] font-medium text-content/70 hover:bg-content/10 hover:text-content"
                  onClick={() => retryHealth(id)}
                >
                  Try again
                </button>
              </div>
            ) : null}
            {entry.health ? (
              <HealthBody health={entry.health} roundTripMs={entry.unreachable ? null : entry.roundTripMs} />
            ) : entry.unreachable ? null : (
              <p className="text-[11px] text-content/45">Asking {host.machine.name}…</p>
            )}
          </section>
        );
      })}
    </>
  );
}
