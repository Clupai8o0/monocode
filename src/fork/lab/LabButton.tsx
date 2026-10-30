import { useRef, useState, type ReactNode } from "react";
import { HomeLab, LoaderCircle } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { useZonePickerOpen } from "./agentTimeZone";
import { AgentTimeZoneSection, zoneHosts } from "./AgentTimeZoneSection";
import { LabHealthSection } from "./LabHealthSection";
import { labChip, remoteDesktopView, uresourcedView, type LabChip } from "./labModel";
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
 * Fork: footer chip for the home lab. Shows the Remote Control scope and the
 * relay in a few words, with an amber dot when something needs the owner
 * (a host offline, uresourced looping, remote desktop on). Opens a popover
 * that switches each Home lab setting in one click. Hidden until a lab host
 * is paired, and under the test runner.
 */
export const FORK_LAB_BUTTON = import.meta.env.MODE !== "test";

export function LabButton() {
  return FORK_LAB_BUTTON ? <Lab /> : null;
}

export function chipFor(state: LabState): LabChip {
  return labChip(
    state.hosts.map((host) => ({ name: host.machine.name, status: host.status, offline: host.offline })),
    state.local?.scope,
  );
}

function Lab() {
  const state = useLab();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // Escape in the zone search closes the search, not the popover.
  const pickerOpen = useZonePickerOpen();
  if (!state.hosts.length) {
    return null;
  }
  const chip = chipFor(state);
  const attention = chip.attention.length > 0;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-fork-lab=""
        className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 hover:bg-content/10 ${
          open ? "text-accent" : "text-content/70 hover:text-content"
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={chip.sentence}
        title={chip.sentence}
        onClick={() => {
          if (!open) {
            void refreshLab();
          }
          setOpen(!open);
        }}
      >
        <HomeLab className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="hidden tabular-nums min-[1100px]:inline">{chip.words}</span>
        {attention ? <span className="size-1.5 shrink-0 rounded-full bg-amber-400" aria-hidden /> : null}
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          gap={6}
          width={332}
          ignore="[data-fork-lab]"
          autoFocus
          dismissOnEscape={!pickerOpen}
          aria-label="Home lab"
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") {
              anchor.current?.focus();
            }
          }}
        >
          <LabPanel state={state} onSettings={() => setOpen(false)} />
        </Popover>
      ) : null}
    </>
  );
}

const SCOPE_OPTIONS: { value: RemoteControlScope; label: string; title: string }[] = [
  { value: "all", label: "Every machine", title: "Claude sessions start with Remote Control on everywhere" },
  { value: "lab", label: "Lab only", title: "Only the Linux machines keep it on; this Mac turns it off" },
];

const small =
  "rounded px-1.5 py-0.5 text-[11px] font-medium text-content/70 bg-content/6 hover:bg-content/10 hover:text-content disabled:cursor-not-allowed disabled:opacity-40";

export function LabPanel({ state, onSettings }: { state: LabState; onSettings?: () => void }) {
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
    <div className="flex max-h-[520px] flex-col gap-4 overflow-y-auto p-3 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-content">Home lab</span>
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
