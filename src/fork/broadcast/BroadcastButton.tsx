import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { remoteSessionActions } from "../../features/connections/model/remoteSessionActions";
import { isMonoSession } from "../../features/monos/model/mono";
import { isRemoteProjectPath, sameProjectPath } from "../../features/projects/model/recents";
import { getComposerDraft } from "../../features/sessions/model/draftCache";
import {
  sessionDisplayTitle,
  sessionNeedsInput,
  type Session,
} from "../../features/sessions/model/session";
import { LAYER } from "../../shared/lib/layers";
import { projectName } from "../../shared/lib/paths";
import { Send } from "../../shared/ui/icons";
import { Segmented } from "../lab/labUi";
import {
  broadcastProjects,
  connectBroadcast,
  leftOutLine,
  planBroadcast,
  sendBroadcast,
  sendLabel,
  type BroadcastApp,
  type BroadcastFacts,
  type BroadcastPlan,
  type BroadcastResult,
  type BroadcastScope,
} from "./broadcastModel";

/** Off under the test runner, so upstream footer tests see no extra button. */
export const FORK_BROADCAST = import.meta.env.MODE !== "test";

const REFRESH_MS = 1_000;

type ScopeChoice = "project" | "all" | "one";

const SCOPES: { value: ScopeChoice; label: string }[] = [
  { value: "project", label: "This project" },
  { value: "all", label: "All projects" },
  { value: "one", label: "One project" },
];

const OUTCOME: Record<BroadcastResult["outcome"], string> = {
  sent: "Sent",
  queued: "Queued for after this turn",
  failed: "Failed",
};

function factsFor(scope: BroadcastScope, project: string | undefined): BroadcastFacts {
  return {
    scope,
    project,
    sameProject: sameProjectPath,
    isMono: isMonoSession,
    isOrchestrationLead: (session) =>
      (session as Session).blocks.some((block) => block.orchestration),
    needsInput: (session) => sessionNeedsInput(session as Session),
    composerDraft: getComposerDraft,
    isRemote: isRemoteProjectPath,
    remoteReachable: (id) => !!remoteSessionActions(id),
  };
}

/**
 * Fork: footer button "Send to all". Opens a bar above the footer with one
 * text box, a scope switch and the sessions it will reach; nothing goes out
 * until its send button is clicked. App lends it the sessions and the
 * composer's send path (BROADCAST_EVENT).
 */
export function BroadcastButton() {
  return FORK_BROADCAST ? <Broadcast /> : null;
}

function Broadcast() {
  const [open, setOpen] = useState(false);
  // Kept while closed, so a slip of the Escape key loses nothing.
  const [text, setText] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-fork-broadcast=""
        className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 hover:bg-content/10 ${
          open ? "text-accent" : "text-content/40 hover:text-content"
        }`}
        aria-expanded={open}
        aria-label="Send to all"
        title="Send one message to many sessions"
        onClick={() => setOpen(!open)}
      >
        <Send className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="hidden min-[1100px]:inline">Send to all</span>
      </button>
      {open
        ? createPortal(
            <BroadcastBar
              text={text}
              onText={setText}
              onClose={() => {
                setOpen(false);
                anchor.current?.focus();
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function BroadcastBar({
  text,
  onText,
  onClose,
}: {
  text: string;
  onText: (text: string) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<ScopeChoice>("project");
  const [picked, setPicked] = useState<string>();
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [results, setResults] = useState<ReadonlyMap<string, BroadcastResult>>(new Map());
  const [app, setApp] = useState<BroadcastApp<Session> | null>(() => connectBroadcast<Session>());
  // Sessions come and go, and turn busy, while the bar is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setApp(connectBroadcast<Session>());
      setTick((tick) => tick + 1);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const sessions = app?.sessions() ?? [];
  const projects = broadcastProjects(sessions, {
    sameProject: sameProjectPath,
    isMono: isMonoSession,
  });
  // One that emptied out stays listed, so the choice doesn't jump elsewhere.
  const pickedPath = picked ?? app?.project() ?? projects[0];
  const pickable =
    pickedPath && !projects.some((path) => sameProjectPath(path, pickedPath))
      ? [pickedPath, ...projects]
      : projects;
  const scope: BroadcastScope =
    choice === "one" ? (pickedPath ? { path: pickedPath } : "project") : choice;
  const plan: BroadcastPlan = planBroadcast(sessions, factsFor(scope, app?.project()));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const chosen = plan.targets.filter(
    (target) => !target.blocked && !unticked.has(target.id),
  );
  const [sending, setSending] = useState(false);
  const canSend = !!app && !!text.trim() && chosen.length > 0 && !sending;
  const failed = [...results.values()].filter((result) => result.outcome === "failed");

  const send = async () => {
    const live = connectBroadcast<Session>();
    if (!live || !canSend) {
      return;
    }
    const fresh = planBroadcast(live.sessions(), factsFor(scope, live.project()));
    setSending(true);
    const outcome = await sendBroadcast(
      new Set(chosen.map((target) => target.id)),
      fresh,
      text,
      live.submit,
    );
    setSending(false);
    setResults(new Map(outcome.map((result) => [result.id, result])));
    // A second click only tries the ones that failed.
    const failedIds = new Set(
      outcome.filter((result) => result.outcome === "failed").map((result) => result.id),
    );
    setUnticked(
      failedIds.size
        ? new Set(plan.targets.map((target) => target.id).filter((id) => !failedIds.has(id)))
        : new Set(),
    );
    if (!failedIds.size) {
      onText("");
    }
  };

  const toggle = (id: string, on: boolean) => {
    const next = new Set(unticked);
    if (on) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setUnticked(next);
  };

  const leftOut = leftOutLine(plan.leftOut);
  return (
    <div
      role="dialog"
      aria-label="Send to all"
      data-fork-broadcast-bar=""
      style={{ zIndex: LAYER.popover }}
      className="fixed right-3 bottom-9 flex max-h-[min(460px,70dvh)] w-[min(560px,calc(100vw-24px))] flex-col gap-2.5 rounded-xl bg-background-base/95 p-3 text-[12px] text-content shadow-lg ring-1 ring-content/10 backdrop-blur"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={text}
        readOnly={sending}
        aria-label="Message"
        placeholder="Message for these sessions"
        onChange={(event) => {
          onText(event.target.value);
          setResults(new Map());
        }}
        className="min-h-12 resize-none rounded-lg bg-content/5 px-2.5 py-2 text-[13px] leading-snug outline-none placeholder:text-content/35 focus:bg-content/8"
      />
      <div className="flex items-center gap-2 whitespace-nowrap">
        <Segmented label="Which sessions" options={SCOPES} value={choice} onChange={setChoice} />
        {choice === "one" ? (
          <select
            aria-label="Project"
            value={pickedPath ?? ""}
            onChange={(event) => setPicked(event.target.value)}
            className="min-w-0 max-w-40 shrink rounded-md bg-content/5 px-1.5 py-1 text-[12px] text-content outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {pickable.map((path) => (
              <option key={path} value={path}>
                {projectName(path)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {leftOut ? <p className="text-[11px] text-content/45">{leftOut}</p> : null}
      <ul aria-label="Sessions it will reach" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {plan.targets.map((target) => {
          const session = byId.get(target.id);
          const title = session
            ? sessionDisplayTitle(session.title, session.harness)
            : target.id;
          const result = results.get(target.id);
          return (
            <li key={target.id} data-fork-broadcast-session={target.id}>
              <label
                className={`flex items-center gap-2 rounded-md px-1.5 py-1 ${
                  target.blocked ? "text-content/45" : "cursor-pointer hover:bg-content/5"
                }`}
                title={target.blocked}
              >
                <input
                  type="checkbox"
                  className="shrink-0 accent-[var(--color-accent)]"
                  disabled={!!target.blocked}
                  checked={!target.blocked && !unticked.has(target.id)}
                  onChange={(event) => toggle(target.id, event.target.checked)}
                />
                <span className="min-w-0 truncate">{title}</span>
                {scope === "all" && session ? (
                  <span className="shrink-0 text-content/40">{projectName(session.cwd)}</span>
                ) : null}
                <span
                  className={`ml-auto shrink-0 truncate text-[11px] ${
                    result?.outcome === "failed"
                      ? "text-red-500 dark:text-red-400"
                      : "text-content/45"
                  }`}
                  title={result?.why}
                >
                  {result
                    ? result.why
                      ? `${OUTCOME[result.outcome]}: ${result.why}`
                      : OUTCOME[result.outcome]
                    : (target.blocked ?? (target.when === "now" ? "" : target.when))}
                </span>
              </label>
            </li>
          );
        })}
        {plan.targets.length === 0 ? (
          <li className="px-1.5 py-1 text-content/50">
            {app ? "No session here can take a message right now." : "Sessions aren't available yet."}
          </li>
        ) : null}
      </ul>
      <div className="flex items-center gap-2">
        {failed.length ? (
          <span role="alert" className="text-[11px] text-red-500 dark:text-red-400">
            {failed.length} failed. Your message is still here.
          </span>
        ) : null}
        <button
          type="button"
          className="ml-auto rounded-md px-2 py-1 text-content/55 hover:bg-content/8 hover:text-content"
          onClick={onClose}
        >
          Close
        </button>
        <button
          type="button"
          disabled={!canSend}
          className="rounded-md bg-accent px-2.5 py-1 font-medium text-white transition-opacity disabled:opacity-40"
          onClick={() => void send()}
        >
          {sending ? "Sending…" : sendLabel(chosen.length)}
        </button>
      </div>
    </div>
  );
}
