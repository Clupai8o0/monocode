import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SmartPhone } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { textControlClass } from "../../features/sessions/ui/ModelPicker";
import { setClaudeRemoteControl } from "../../integrations/harness/providers/claude/claude";
import {
  remoteControlWanted,
  setRemoteControlState,
  setRemoteControlWanted,
  useRemoteControl,
  type RemoteControlState,
} from "./remoteControlStore";

/**
 * Fork: composer button that puts a Claude session under Remote Control, so
 * the Claude app on the phone (or claude.ai/code) can read and drive it. The
 * popover turns it on or off and shows the session's link as a QR code.
 */
export const FORK_REMOTE_CONTROL = import.meta.env.MODE !== "test";

export function RemoteControlButton({ sessionId }: { sessionId: string }) {
  return FORK_REMOTE_CONTROL ? <RemoteControl sessionId={sessionId} /> : null;
}

export function turnRemoteControlOn(sessionId: string): void {
  setRemoteControlWanted(sessionId, true);
  if (!setClaudeRemoteControl(sessionId, true)) {
    // Not running yet: it starts with this session's Claude.
    setRemoteControlState(sessionId, { status: "off" });
  }
}

export function turnRemoteControlOff(sessionId: string): void {
  setRemoteControlWanted(sessionId, false);
  if (!setClaudeRemoteControl(sessionId, false)) {
    setRemoteControlState(sessionId, { status: "off" });
  }
}

function RemoteControl({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const state = useRemoteControl(sessionId);
  const on = state.status === "on";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-fork-remote-control=""
        className={textControlClass(open || on, "shrink-0 gap-1.5 whitespace-nowrap")}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Remote Control"
        title={buttonTitle(state)}
        onClick={() => setOpen(!open)}
      >
        <span className="relative">
          <SmartPhone className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
          {state.status !== "off" ? (
            <span
              aria-hidden
              className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ${dotClass(state)}`}
            />
          ) : null}
        </span>
        <span className="hidden @min-[420px]/composer-toolbar:inline">
          {on ? "Remote on" : "Remote"}
        </span>
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="start"
          gap={6}
          width={300}
          ignore="[data-fork-remote-control]"
          autoFocus
          aria-label="Remote Control"
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") anchor.current?.focus();
          }}
        >
          <RemoteControlPanel sessionId={sessionId} state={state} />
        </Popover>
      ) : null}
    </>
  );
}

function buttonTitle(state: RemoteControlState): string {
  switch (state.status) {
    case "on":
      return "Remote Control is on: open this session on your phone";
    case "starting":
      return "Remote Control is starting";
    case "waiting":
      return "Remote Control starts with this session's next message";
    case "failed":
      return `Remote Control failed: ${state.error}`;
    default:
      return "Remote Control: drive this session from your phone";
  }
}

function dotClass(state: RemoteControlState): string {
  switch (state.status) {
    case "on":
      return "bg-emerald-500";
    case "failed":
      return "bg-amber-500";
    default:
      return "animate-pulse bg-accent";
  }
}

const ACTION =
  "rounded px-1.5 py-0.5 font-medium text-content/80 bg-content/6 hover:bg-content/10 hover:text-content disabled:opacity-40";

function RemoteControlPanel({
  sessionId,
  state,
}: {
  sessionId: string;
  state: RemoteControlState;
}) {
  const wanted = remoteControlWanted(sessionId);
  const busy = state.status === "starting" || state.status === "stopping";
  const showOff =
    state.status === "on" || state.status === "waiting" || state.status === "starting" || wanted;
  return (
    <div className="flex flex-col gap-2 p-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-content">Remote Control</span>
        <button
          type="button"
          autoFocus
          disabled={busy}
          className={ACTION}
          onClick={() =>
            showOff ? turnRemoteControlOff(sessionId) : turnRemoteControlOn(sessionId)
          }
        >
          {showOff ? "Turn off" : "Turn on"}
        </button>
      </div>
      <span className="text-content/55">
        Drive this session from the Claude app on your phone, or claude.ai/code. It
        stays awake while MonoCode is open.
      </span>
      <StateLine state={state} />
      {state.status === "on" && state.url ? <SessionLink url={state.url} /> : null}
    </div>
  );
}

function StateLine({ state }: { state: RemoteControlState }) {
  switch (state.status) {
    case "waiting":
      return (
        <span className="text-content/70">
          Starts when this session's Claude starts. Send a message to start it now.
        </span>
      );
    case "starting":
      return <span className="text-content/70">Starting…</span>;
    case "stopping":
      return <span className="text-content/70">Turning off…</span>;
    case "failed":
      return <span className="text-amber-500">{state.error}</span>;
    case "on":
      if (state.error) {
        return (
          <span className="text-amber-500">Still on: {state.error}</span>
        );
      }
      return state.url ? null : (
        <span className="text-content/70">
          On. Find this session in the Claude app under Code.
        </span>
      );
    default:
      return null;
  }
}

function SessionLink({ url }: { url: string }) {
  const [image, setImage] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let disposed = false;
    void QRCode.toDataURL(url, { width: 360, margin: 1, errorCorrectionLevel: "L" })
      .then((value) => {
        if (!disposed) setImage(value);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [url]);
  return (
    <div className="flex flex-col items-center gap-2">
      {image ? (
        <img
          src={image}
          alt="QR code for this session's Remote Control link"
          className="size-40 rounded bg-white p-1"
        />
      ) : null}
      <span className="text-content/55">Scan with your phone's camera.</span>
      <div className="flex w-full items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-content/70" title={url}>
          {url}
        </span>
        <button
          type="button"
          className={ACTION}
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className={ACTION} onClick={() => void openUrl(url)}>
          Open
        </button>
      </div>
    </div>
  );
}
