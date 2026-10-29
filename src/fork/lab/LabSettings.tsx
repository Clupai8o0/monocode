import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import { Loader } from "../../shared/ui/icons";
import {
  SCOPES,
  choiceLine,
  errorText,
  localMachineName,
  localRelayLine,
  machineRows,
  relayLine,
  remoteDesktopView,
  timeAgo,
  uresourcedView,
  type LocalRelayStatus,
  type LocalRemoteControl,
} from "./labModel";
import type { LabParams, LabStatus, RemoteControlScope } from "./labProtocol";
import {
  actionKey,
  hostErrors,
  probeLab,
  refreshLab,
  reloadHost,
  setRelay,
  setRemoteDesktop,
  setScope,
  setUresourced,
  useLab,
  type HostAction,
  type LabHost,
  type LabState,
} from "./labStore";
import { Block, CopyButton, Toggle, useNow } from "./labUi";

/**
 * Fork: the "Home lab" settings section. One panel per connected machine
 * whose host offers the lab methods, with four blocks: Remote Control scope,
 * relay, uresourced and remote desktop. A block is left out when the host
 * has nothing for it (uresourced and remote desktop are Linux only). The
 * state and the changes live in labStore, shared with the footer chip.
 */

const button =
  "rounded-lg bg-selection px-3 py-1.5 text-[12px] font-medium hover:bg-selection-hover disabled:opacity-40";
const quiet = "text-[12px] leading-relaxed text-content/50";

/** What is changing on a host, in the words the blocks check for. */
function hostBusyWord(state: LabState, machineId: string): string | undefined {
  if (state.busy.scope) {
    return "scope";
  }
  const actions: HostAction[] = ["relay", "ures", "probe", "rdp", "tz", "scope"];
  return actions.find((action) => state.busy[actionKey(machineId, action)]);
}

export function LabSettings()
{
  const state = useLab();
  const { hosts, machinesLoaded, discovering, machineCount } = state;
  const now = useNow();
  useEffect(() => {
    void refreshLab();
  }, []);

  if (!machinesLoaded || (discovering && machineCount > 0)) {
    return (
      <p className={`${quiet} flex items-center gap-2`}>
        <Loader className="size-4 animate-spin" /> Looking for lab machines…
      </p>
    );
  }
  if (!hosts.length) {
    return (
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[13px] font-semibold text-content">No lab machine connected</h2>
        <p className={quiet}>
          Connect a machine running an up-to-date host under Connections, and its
          controls show up here.
        </p>
        <div>
          <button className={button} onClick={() => void refreshLab({ rediscover: true })}>
            Check again
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-12">
      {hosts.map((host) => (
        <HostPanel key={host.machine.id} host={host} state={state} now={now} />
      ))}
    </div>
  );
}

function HostPanel({ host, state, now }: { host: LabHost; state: LabState; now: number })
{
  const machine: RemoteMachine = host.machine;
  const { status } = host;
  const busy = hostBusyWord(state, machine.id);
  const error = hostErrors(state, machine.id).join(" ");

  return (
    <section aria-label={machine.name} className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold text-content">
            {status?.machine && status.machine !== machine.name
              ? `${machine.name} (${status.machine})`
              : machine.name}
          </h2>
          <p className={`mt-1 ${quiet}`}>
            {status ? "Home lab controls for this machine." : host.loading ? "Loading…" : ""}
          </p>
        </div>
        <button
          className={button}
          disabled={!!busy || host.loading}
          onClick={() => void reloadHost(machine.id)}
        >
          Refresh
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-[12px] leading-relaxed text-red-500">
          {error}
        </p>
      ) : null}
      {status ? (
        <>
          <RemoteControlBlock
            status={status}
            local={state.local}
            localError={state.localError}
            busy={busy}
            now={now}
            onChoose={(scope) => void setScope(scope)}
          />
          <RelayBlock
            status={status}
            machineId={machine.id}
            local={state.relay}
            localError={state.relayError}
            busy={busy}
            now={now}
            onToggle={(enabled) => void setRelay(machine.id, enabled)}
          />
          {status.uresourced ? (
            <UresourcedBlock
              status={status.uresourced}
              busy={busy}
              now={now}
              onProbe={() => void probeLab(machine.id)}
              onAction={(action) => void setUresourced(machine.id, action)}
            />
          ) : null}
          {status.remoteDesktop ? (
            <RemoteDesktopBlock
              status={status.remoteDesktop}
              machineName={machine.name}
              busy={busy}
              onToggle={(enabled) => void setRemoteDesktop(machine.id, enabled)}
            />
          ) : null}
        </>
      ) : !error ? (
        <p className={`${quiet} flex items-center gap-2`}>
          <Loader className="size-4 animate-spin" /> Asking {machine.name}…
        </p>
      ) : null}
    </section>
  );
}

function RemoteControlBlock({
  status,
  local,
  localError,
  busy,
  now,
  onChoose,
}: {
  status: LabStatus;
  local?: LocalRemoteControl;
  localError: string;
  busy?: string;
  now: number;
  onChoose: (scope: RemoteControlScope) => void;
})
{
  const desired = status.remoteControl.desired;
  const rows = machineRows(status, local, localMachineName(local), now);
  return (
    <Block title="Remote Control" state={busy === "scope" ? "Saving…" : undefined}>
      <p className={quiet}>Where new Claude sessions start with Remote Control on.</p>
      <div role="radiogroup" aria-label="Remote Control scope" className="grid gap-2 @min-[560px]/settings:grid-cols-2">
        {SCOPES.map((option) => {
          const selected = desired.scope === option.scope;
          return (
            <button
              key={option.scope}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!!busy}
              onClick={() => {
                if (!selected) {
                  onChoose(option.scope);
                }
              }}
              className={`flex flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${
                selected ? "bg-accent/15 text-content" : "bg-content/4 text-content/75 hover:bg-content/7"
              }`}
            >
              <span className="text-[13px] font-medium">{option.label}</span>
              <span className="text-[11px] leading-snug text-content/50">{option.detail}</span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-content/45">{choiceLine(desired, now)}</p>
      {localError ? <p className="text-[12px] text-red-500">{localError}</p> : null}
      {rows.length ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.key} className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-content/85">{row.name}</div>
                <div className="truncate text-[11px] text-content/45">{row.detail}</div>
              </div>
              <div className={`shrink-0 text-[12px] ${row.pending ? "text-amber-500" : "text-content/60"}`}>
                {row.accounts}
                {row.pending ? " · not applied yet" : ""}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Block>
  );
}

function RelayBlock({
  status,
  machineId,
  local,
  localError,
  busy,
  now,
  onToggle,
}: {
  status: LabStatus;
  machineId: string;
  local?: LocalRelayStatus;
  localError: string;
  busy?: string;
  now: number;
  onToggle: (enabled: boolean) => void;
})
{
  const relay = status.relay;
  const mine = localRelayLine(local, machineId, now);
  return (
    <Block
      title="Relay"
      state={
        <span className="flex items-center gap-3">
          {busy === "relay" ? "Saving…" : relay.enabled ? "On" : "Off"}
          <Toggle label="Relay" on={relay.enabled} disabled={!!busy} onChange={onToggle} />
        </span>
      }
    >
      <p className={quiet}>Lets Claude sessions on different machines and accounts message each other.</p>
      {relay.enabled ? <p className="text-[12px] text-content/70">{relayLine(relay)}</p> : null}
      {relay.peers.length ? (
        <ul className="flex flex-col gap-1">
          {relay.peers.map((peer) => (
            <li key={peer.id} className="flex justify-between gap-3 text-[12px]">
              <span className="truncate text-content/80">{peer.name}</span>
              <span className="shrink-0 text-content/45">
                {peer.sessions} session{peer.sessions === 1 ? "" : "s"} · seen {timeAgo(peer.lastSeen, now)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {mine ? <p className="text-[11px] text-content/45">{mine}</p> : null}
      {localError ? <p className="text-[11px] text-content/45">{localError}</p> : null}
    </Block>
  );
}

function UresourcedBlock({
  status,
  busy,
  now,
  onProbe,
  onAction,
}: {
  status: NonNullable<LabStatus["uresourced"]>;
  busy?: string;
  now: number;
  onProbe: () => void;
  onAction: (action: LabParams["lab.uresourced.set"]["action"]) => void;
})
{
  const view = uresourcedView(status, now);
  const [confirming, setConfirming] = useState(false);
  const working = busy === "ures" || busy === "probe";
  return (
    <Block
      title="uresourced"
      state={
        <span className={view.tone === "good" ? "text-green-600" : view.tone === "warn" ? "text-amber-500" : undefined}>
          {working ? "Working…" : view.state}
        </span>
      }
    >
      <p className={quiet}>Fedora's resource helper. When it fights systemd it can burn the CPU.</p>
      {view.looping ? (
        <p role="alert" className="text-[12px] font-medium text-amber-500">
          It looks stuck in a loop. Turning it off stops that.
        </p>
      ) : null}
      <p className="text-[11px] text-content/45">{view.calls ?? "Not checked yet."}</p>
      {confirming ? (
        <div role="group" aria-label="Confirm turning uresourced off" className="flex flex-wrap items-center gap-3">
          <span className="text-[12px] text-content/70">Stop it and keep it off, even after a restart?</span>
          <button
            className={button}
            disabled={!!busy}
            onClick={() => {
              setConfirming(false);
              onAction("off");
            }}
          >
            Turn off
          </button>
          <button className="text-[12px] text-content/55 hover:text-content" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={!!busy} onClick={onProbe}>
            Check now
          </button>
          {view.canTurnOff ? (
            <button className={button} disabled={!!busy} onClick={() => setConfirming(true)}>
              Turn off
            </button>
          ) : null}
          {view.canTurnOn ? (
            <button className={button} disabled={!!busy} onClick={() => onAction("on")}>
              Turn on
            </button>
          ) : null}
          {view.canRestart ? (
            <button className={button} disabled={!!busy} onClick={() => onAction("restart")}>
              Restart
            </button>
          ) : null}
        </div>
      )}
    </Block>
  );
}

function RemoteDesktopBlock({
  status,
  machineName,
  busy,
  onToggle,
}: {
  status: NonNullable<LabStatus["remoteDesktop"]>;
  machineName: string;
  busy?: string;
  onToggle: (enabled: boolean) => void;
})
{
  const view = remoteDesktopView(status);
  const [openError, setOpenError] = useState("");
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (!status.rdpFile) {
      return;
    }
    setOpening(true);
    setOpenError("");
    try {
      await invoke("fork_lab_open_rdp", { name: machineName, rdp: status.rdpFile });
    } catch (reason) {
      setOpenError(errorText(reason, "Opening remote desktop"));
    } finally {
      setOpening(false);
    }
  };
  return (
    <Block
      title="Remote desktop"
      state={
        <span className="flex items-center gap-3">
          {busy === "rdp" ? "Working…" : view.state}
          {status.installed ? (
            <Toggle label="Remote desktop" on={view.on} disabled={!!busy} onChange={onToggle} />
          ) : null}
        </span>
      }
    >
      <p className={quiet}>See and use this machine's screen. Sign in with its Linux password.</p>
      {view.warnings.map((warning) => (
        <p key={warning} role="alert" className="text-[12px] font-medium text-amber-500">
          {warning}
        </p>
      ))}
      {view.notes.map((note) => (
        <p key={note} className="text-[11px] text-content/50">
          {note}
        </p>
      ))}
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-[12px]">
        {view.address ? (
          <>
            <dt className="text-content/45">Address</dt>
            <dd className="flex min-w-0 items-center gap-1 font-mono text-content/80">
              <span className="truncate">{view.address}</span>
              <CopyButton text={view.address} label="address" />
            </dd>
          </>
        ) : null}
        <dt className="text-content/45">Username</dt>
        <dd className="flex min-w-0 items-center gap-1 font-mono text-content/80">
          <span className="truncate">{view.username}</span>
          <CopyButton text={view.username} label="username" />
        </dd>
        {view.fingerprint ? (
          <>
            <dt className="text-content/45">Certificate</dt>
            <dd className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-content/60">
              <span className="truncate" title={view.fingerprint}>
                {view.fingerprint}
              </span>
              <CopyButton text={view.fingerprint} label="certificate fingerprint" />
            </dd>
          </>
        ) : null}
      </dl>
      {view.on && status.rdpFile ? (
        <div className="flex flex-wrap items-center gap-3">
          <button className={button} disabled={opening} onClick={() => void open()}>
            {opening ? "Opening…" : "Open on this Mac"}
          </button>
          {openError ? <span className="text-[12px] text-red-500">{openError}</span> : null}
        </div>
      ) : null}
    </Block>
  );
}
