import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openRemoteProjectOn } from "../../features/connections/model/connections";
import { LoaderCircle } from "../../shared/ui/icons";
import { closeMachines, useMachineHost, useMachineSignal } from "../machines/machinesStore";
import { AgentTimeZoneSection, zoneHosts } from "./AgentTimeZoneSection";
import { LabHealthSection } from "./LabHealthSection";
import { useLabHealthDot } from "./labHealthStore";
import { liveSessions, useRemoteSessions } from "../externalSessions/externalSessionsStore";
import {
  hostRunningLine,
  hostTitle,
  labChip,
  remoteDesktopView,
  uresourcedView,
  type LabChip,
} from "./labModel";
import type { LabParams, LabStatus, RemoteControlScope } from "./labProtocol";
import {
  actionKey,
  hostBusy,
  openLabSettings,
  probeLab,
  refreshLab,
  reloadHost,
  setRelay,
  setRemoteDesktop,
  setScope,
  setUresourced,
  useLab,
  type LabHost,
  type LabState,
} from "./labStore";
import { CopyButton, Segmented, Toggle, useNow } from "./labUi";

/**
 * Fork: the Lab tab of the footer's Machines chip. Lights the chip's dot when
 * something needs the owner (a host offline, uresourced looping, remote desktop
 * on, lab health). The tab says how many sessions run on the lab, starts a
 * session on a host and switches each Home lab setting in one click. Off under
 * the test runner.
 */
export const FORK_LAB_BUTTON = import.meta.env.MODE !== "test";

export function LabButton() {
  return FORK_LAB_BUTTON ? <Lab /> : null;
}

type RunningByHost = ReadonlyMap<string, number>;

export function chipFor(state: LabState, running: RunningByHost = new Map()): LabChip {
  return labChip(
    state.hosts.map((host) => ({
      name: host.machine.name,
      status: host.status,
      offline: host.offline,
      running: running.get(host.machine.id),
    })),
    state.local?.scope,
  );
}

function Lab() {
  const state = useLab();
  const host = useMachineHost("lab");
  const open = host !== null;
  const sessions = useRemoteSessions(state.hosts.map((labHost) => labHost.machine.id));
  // Polls every 30 s while the footer shows, every 5 s while this tab does.
  const health = useLabHealthDot(open);
  const running = new Map(
    [...sessions].map(([machineId, rows]) => [machineId, liveSessions(rows).filter((row) => row.state === "running").length]),
  );
  const chip = chipFor(state, running);
  const paired = state.hosts.length > 0;
  const tone = health.tone === "red" ? "red" : chip.attention.length > 0 || health.tone ? "amber" : null;
  useMachineSignal("lab", {
    tone,
    why: [...chip.attention, health.reason].filter(Boolean).join(" "),
    detail: paired ? chip.words : "",
  });
  useEffect(() => {
    if (open) {
      void refreshLab();
    }
  }, [open]);
  if (!host) {
    return null;
  }
  return createPortal(
    <div aria-label="Home lab" title={paired ? chip.sentence : undefined}>
      {paired ? (
        <LabPanel state={state} running={running} words={chip.words} onSettings={closeMachines} />
      ) : (
        <div className="flex flex-col items-start gap-2 p-3 text-[12px] text-content/50">
          <p>No lab machine is paired yet.</p>
          <button
            type="button"
            className="rounded px-1 text-[11px] text-content/70 hover:bg-content/10 hover:text-content"
            onClick={() => {
              closeMachines();
              openLabSettings();
            }}
          >
            Settings
          </button>
        </div>
      )}
    </div>,
    host,
  );
}

const SCOPE_OPTIONS: { value: RemoteControlScope; label: string; title: string }[] = [
  { value: "all", label: "Every machine", title: "Claude sessions start with Remote Control on everywhere" },
  { value: "lab", label: "Lab only", title: "Only the Linux machines keep it on; this Mac turns it off" },
];

const small =
  "rounded px-1.5 py-0.5 text-[11px] font-medium text-content/70 bg-content/6 hover:bg-content/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-40";

export function LabPanel({
  state,
  running,
  words,
  onSettings,
}: {
  state: LabState;
  running: RunningByHost;
  words?: string;
  onSettings?: () => void;
}) {
  const now = useNow();
  const reachable = state.hosts.filter((host) => host.status && !host.offline);
  const scope = reachable[0]?.status?.remoteControl.desired.scope ?? state.local?.scope;
  const several = state.hosts.length > 1;
  const scopeError = [
    state.errors.scope,
    ...state.hosts.flatMap((host) => {
      const error = state.errors[actionKey(host.machine.id, "scope")];
      return error ? [several ? `${host.machine.name}: ${error}` : error] : [];
    }),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-4 p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-content">Home lab</span>
        {words ? (
          <span data-fork-lab-words="" className="min-w-0 truncate tabular-nums text-content/45">
            {words}
          </span>
        ) : null}
        {state.hosts.some((host) => host.loading) ? (
          <LoaderCircle className="size-3 animate-spin text-content/40" aria-label="Checking" />
        ) : null}
        <button
          type="button"
          className="ml-auto rounded px-1 text-[11px] text-content/50 hover:bg-content/10 hover:text-content"
          onClick={() => {
            onSettings?.();
            openLabSettings();
          }}
        >
          Settings
        </button>
      </div>

      <div className="flex flex-col gap-1.5" aria-label="Work on the lab">
        {state.hosts.map((host) => (
          <div key={host.machine.id} className="flex min-w-0 flex-col gap-1">
            <span data-fork-lab-running="" className="min-w-0 truncate tabular-nums text-content">
              {host.offline
                ? `${hostTitle(host.machine.name)} · offline`
                : hostRunningLine(host.machine.name, running.get(host.machine.id))}
            </span>
            <button
              type="button"
              className="self-start rounded-md bg-accent/15 px-2 py-1 text-[12px] font-medium text-content transition-colors hover:bg-accent/25 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
              disabled={host.offline}
              onClick={() => {
                onSettings?.();
                openRemoteProjectOn(host.machine.id);
              }}
            >
              New session on {hostTitle(host.machine.name)}
            </button>
          </div>
        ))}
      </div>

      <LabHealthSection hosts={state.hosts} heading={several} />

      <Row
        title="Remote Control"
        gloss="Where new Claude sessions start with it on."
        state={state.busy.scope ? "Saving…" : undefined}
      >
        <Segmented
          label="Remote Control scope"
          options={SCOPE_OPTIONS}
          value={scope}
          disabled={!!state.busy.scope || reachable.length === 0}
          onChange={(next) => void setScope(next)}
        />
        {scopeError ? <ErrorLine text={scopeError} /> : null}
      </Row>

      <AgentTimeZoneSection compact hosts={zoneHosts(state.hosts)} />

      {state.hosts.map((host) => (
        <HostGroup key={host.machine.id} host={host} state={state} heading={several} now={now} />
      ))}
    </div>
  );
}

function HostGroup({ host, state, heading, now }: { host: LabHost; state: LabState; heading: boolean; now: number }) {
  const id = host.machine.id;
  const { status } = host;
  const disabled = host.offline || hostBusy(state, id);
  const loadError = state.errors[actionKey(id, "load")];
  const body = !status ? (
    host.offline ? (
      <OfflineLine name={host.machine.name} detail={loadError} onRetry={() => void reloadHost(id)} />
    ) : (
      <p className="text-content/45">Asking {host.machine.name}…</p>
    )
  ) : (
    <>
      {host.offline ? (
        <OfflineLine name={host.machine.name} detail={loadError} onRetry={() => void reloadHost(id)} />
      ) : null}
      <RelayRow host={host} status={status} state={state} disabled={disabled} />
      {status.uresourced ? (
        <UresourcedRow id={id} status={status.uresourced} state={state} disabled={disabled} now={now} />
      ) : null}
      {status.remoteDesktop ? (
        <RemoteDesktopRow id={id} status={status.remoteDesktop} state={state} disabled={disabled} />
      ) : null}
    </>
  );
  if (!heading) {
    return body;
  }
  return (
    <section aria-label={host.machine.name} className="flex flex-col gap-4">
      <h3 className="-mb-1 text-[11px] font-semibold text-content/45">
        {host.machine.name}
        {host.offline ? <span className="font-normal"> · Offline</span> : null}
      </h3>
      {body}
    </section>
  );
}

function Row({
  title,
  gloss,
  state,
  control,
  children,
}: {
  title: string;
  gloss?: string;
  state?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center gap-2">
        <span className="font-medium text-content">{title}</span>
        <span className="ml-auto shrink-0 text-content/55">{state}</span>
        {control}
      </div>
      {gloss ? <p className="-mt-1 text-[11px] leading-snug text-content/45">{gloss}</p> : null}
      {children}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p role="alert" className="text-[11px] leading-snug text-red-500">
      {text}
    </p>
  );
}

function OfflineLine({ name, detail, onRetry }: { name: string; detail?: string; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-2">
      <p className="min-w-0 flex-1 text-[11px] leading-snug text-amber-500">
        <span className="font-semibold">Offline.</span> {name} isn't answering
        {detail ? ` (${detail.replace(/\.$/, "")})` : ""}, so its controls are off.
      </p>
      <button type="button" className={small} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function RelayRow({
  host,
  status,
  state,
  disabled,
}: {
  host: LabHost;
  status: LabStatus;
  state: LabState;
  disabled: boolean;
}) {
  const id = host.machine.id;
  const on = status.relay.enabled;
  const busy = !!state.busy[actionKey(id, "relay")];
  const error = state.errors[actionKey(id, "relay")];
  const mine = state.relay?.hosts.find((entry) => entry.machineId === id);
  const macLine = !on
    ? null
    : !mine
      ? "This Mac is not linked yet."
      : mine.lastError
        ? "This Mac can't reach it."
        : mine.connected
          ? "This Mac is linked."
          : "This Mac is not linked right now.";
  return (
    <Row
      title="Relay"
      gloss={`Sessions on different machines can message each other.${macLine ? ` ${macLine}` : ""}`}
      state={busy ? "Saving…" : on ? "On" : "Off"}
      control={
        <Toggle
          label={`Relay on ${host.machine.name}`}
          on={on}
          disabled={disabled}
          onChange={(enabled) => void setRelay(id, enabled)}
        />
      }
    >
      {error ? <ErrorLine text={error} /> : null}
    </Row>
  );
}

function UresourcedRow({
  id,
  status,
  state,
  disabled,
  now,
}: {
  id: string;
  status: NonNullable<LabStatus["uresourced"]>;
  state: LabState;
  disabled: boolean;
  now: number;
}) {
  const view = uresourcedView(status, now);
  const [confirming, setConfirming] = useState(false);
  const working = !!state.busy[actionKey(id, "ures")] || !!state.busy[actionKey(id, "probe")];
  const error = state.errors[actionKey(id, "ures")] ?? state.errors[actionKey(id, "probe")];
  const act = (action: LabParams["lab.uresourced.set"]["action"]) => void setUresourced(id, action);
  const word = working ? "Working…" : view.looping ? "Looping" : shortUres(view.state);
  return (
    <Row
      title="uresourced"
      gloss="Fedora's resource helper. It can burn the CPU when it fights systemd."
      state={<span className={view.looping && !working ? "font-medium text-amber-500" : undefined}>{word}</span>}
    >
      {view.looping ? (
        <p role="alert" className="text-[11px] font-medium leading-snug text-amber-500">
          It looks stuck in a loop. Turning it off stops that.
        </p>
      ) : null}
      {status.installed ? (
        confirming ? (
          <div role="group" aria-label="Confirm turning uresourced off" className="flex flex-wrap items-center gap-1.5">
            <span className="mr-auto text-[11px] text-content/70">Stop it and keep it off, even after a restart?</span>
            <button
              type="button"
              className={small}
              disabled={disabled}
              onClick={() => {
                setConfirming(false);
                act("off");
              }}
            >
              Turn off
            </button>
            <button type="button" className={small} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {view.canTurnOff ? (
              <button type="button" className={small} disabled={disabled} onClick={() => setConfirming(true)}>
                Turn off
              </button>
            ) : null}
            {view.canTurnOn ? (
              <button type="button" className={small} disabled={disabled} onClick={() => act("on")}>
                Turn on
              </button>
            ) : null}
            {view.canRestart ? (
              <button type="button" className={small} disabled={disabled} onClick={() => act("restart")}>
                Restart
              </button>
            ) : null}
            {status.active ? (
              <button
                type="button"
                className={small}
                disabled={disabled}
                title="Take a fresh 2 second look for a loop"
                onClick={() => void probeLab(id)}
              >
                Check now
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {error ? <ErrorLine text={error} /> : null}
    </Row>
  );
}

/** "Running, started 3 h ago" fits the popover as "Running". */
function shortUres(state: string): string {
  return state.startsWith("Running") ? "Running" : state === "Turned off" ? "Off" : state;
}

function RemoteDesktopRow({
  id,
  status,
  state,
  disabled,
}: {
  id: string;
  status: NonNullable<LabStatus["remoteDesktop"]>;
  state: LabState;
  disabled: boolean;
}) {
  const view = remoteDesktopView(status);
  const busy = !!state.busy[actionKey(id, "rdp")];
  const error = state.errors[actionKey(id, "rdp")];
  return (
    <Row
      title="Remote desktop"
      gloss="See and use the laptop's screen over Tailscale."
      state={busy ? "Working…" : view.on ? "On" : view.state}
      control={
        status.installed ? (
          <Toggle
            label="Remote desktop"
            on={view.on}
            disabled={disabled}
            onChange={(enabled) => void setRemoteDesktop(id, enabled)}
          />
        ) : null
      }
    >
      {view.on && view.address ? (
        <div className="-my-1 flex min-w-0 items-center gap-1 font-mono text-[11px] text-content/75">
          <span className="truncate">{view.address}</span>
          <CopyButton text={view.address} label="address" />
        </div>
      ) : null}
      {view.warnings.map((warning) => (
        <p key={warning} role="alert" className="text-[11px] font-medium leading-snug text-amber-500">
          {warning}
        </p>
      ))}
      {error ? <ErrorLine text={error} /> : null}
    </Row>
  );
}
