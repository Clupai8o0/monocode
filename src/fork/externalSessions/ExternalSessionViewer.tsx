import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { AgentMarkdown } from "../../features/sessions/ui/AgentMarkdown";
import { copyText } from "../../platform/tauri/clipboard";
import { Modal } from "../../shared/ui/Modal";
import { continueFromHandoff } from "../handoff/handoffStore";
import { MoveToMacButton } from "../sessionMove/SessionMoveUi"; // Fork
import { sessionLabel, sourceLabel } from "./ElsewhereGroup";
import type {
  ExternalSession,
  ExternalSessionsTarget,
  ExternalTranscriptPage,
  ExternalTurn,
} from "./externalSessionsModel";
import { readExternalSession } from "./externalSessionsStore";

type Tab = "handoff" | "transcript";

/** How often an open running session re-reads its newest turns. */
const LIVE_POLL_MS = 5000;
const NEAR_BOTTOM_PX = 80;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let at = el?.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) {
      return at;
    }
  }
  return null;
}

const STATE_LABEL: Record<ExternalSession["state"], string> = {
  running: "Running",
  idle: "Idle",
  "handed-over": "Handed over",
};

/** Plain text of the turns, for the clipboard. */
export function transcriptText(turns: ExternalTurn[]): string {
  return turns
    .map((turn) =>
      turn.role === "tool"
        ? `[tool] ${turn.text}`
        : `${turn.role === "user" ? "User" : "Assistant"}:\n${turn.text}`,
    )
    .join("\n\n");
}

function TurnView({ turn }: { turn: ExternalTurn }) {
  if (turn.role === "tool") {
    return (
      <p className="truncate font-mono text-[11px] text-content/40">
        {turn.text.split("\n")[0]}
      </p>
    );
  }
  if (turn.role === "user") {
    return (
      <div className="self-end max-w-[85%] whitespace-pre-wrap rounded-lg bg-content/5 px-3 py-2 text-[13px] text-content">
        {turn.text}
      </div>
    );
  }
  return <AgentMarkdown text={turn.text} className="text-[13px]" />;
}

/** Fork: a read-only look at a session MonoCode did not start. */
export function ExternalSessionViewer({
  target,
  session,
  cwd,
  onClose,
}: {
  target: ExternalSessionsTarget;
  session: ExternalSession;
  /** Where Continue opens a session; without one there is no Continue. */
  cwd?: string;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<ExternalTurn[]>([]);
  const [before, setBefore] = useState<number | undefined>();
  const [handoff, setHandoff] = useState<{ path: string; text: string }>();
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>(
    session.handoffPath ? "handoff" : "transcript",
  );
  const ids = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const olderRef = useRef(false);
  const running = session.state === "running";
  // Reads can overlap, and a slow one must not undo a newer one.
  const readSeq = useRef(0);
  const appliedSeq = useRef(0);
  const readFresh = async (): Promise<ExternalTranscriptPage | null> => {
    const seq = ++readSeq.current;
    const page = await readExternalSession(target, session.id);
    if (seq < appliedSeq.current) {
      return null;
    }
    appliedSeq.current = seq;
    return page;
  };
  const applyFresh = (page: ExternalTranscriptPage) => {
    setTurns(page.turns);
    setBefore(page.before);
    setTruncated(!!page.truncated);
    if (page.handoff) {
      setHandoff(page.handoff);
    }
  };

  // Fork: a running session stays live. Once older turns are loaded the page
  // no longer lines up with the newest one, so it holds still.
  useEffect(() => {
    if (!running) {
      return;
    }
    let cancelled = false;
    let reading = false;
    const timer = window.setInterval(() => {
      if (document.hidden || olderRef.current || reading) {
        return;
      }
      const atBottom = () => {
        const scroller = scrollParent(bodyRef.current);
        followRef.current =
          !scroller ||
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
            NEAR_BOTTOM_PX;
        return followRef.current;
      };
      // Scrolled up to read: the page would shift under the reader.
      if (!atBottom()) {
        return;
      }
      reading = true;
      void readFresh()
        .then((page) => {
          if (page && !cancelled && !olderRef.current && atBottom()) {
            applyFresh(page);
          }
        })
        .catch(() => {
          // The next tick tries again; the turns on screen stay.
        })
        .finally(() => {
          reading = false;
        });
    }, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // The target object is rebuilt each render; its session id is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, session.id]);

  // The turn that ended it may have landed after the last poll.
  const wasRunning = useRef(running);
  useEffect(() => {
    const ended = wasRunning.current && !running;
    wasRunning.current = running;
    if (!ended) {
      return;
    }
    let cancelled = false;
    void readFresh()
      .then((page) => {
        if (page && !cancelled && !olderRef.current) {
          applyFresh(page);
        }
      })
      .catch(() => {
        // The turns on screen stay.
      });
    return () => {
      cancelled = true;
    };
    // The target object is rebuilt each render; its session id is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, session.id]);

  useEffect(() => {
    if (!running || !followRef.current) {
      return;
    }
    const scroller = scrollParent(bodyRef.current);
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [running, turns]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readFresh()
      .then((page) => {
        if (cancelled || !page) {
          return;
        }
        setTurns(page.turns);
        setBefore(page.before);
        setHandoff(page.handoff);
        setTruncated(!!page.truncated);
        if (page.handoff) {
          setTab("handoff");
        }
      })
      .catch((err) => !cancelled && setError(String(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // The target object is rebuilt each render; its session id is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const loadOlder = async () => {
    if (before == null) {
      return;
    }
    setLoading(true);
    const hadOlder = olderRef.current;
    olderRef.current = true;
    followRef.current = false;
    try {
      const page = await readExternalSession(target, session.id, before);
      setTurns((prev) => [...page.turns, ...prev]);
      setBefore(page.before);
      if (page.truncated) {
        setTruncated(true);
      }
    } catch (err) {
      olderRef.current = hadOlder;
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handoffPath = handoff?.path ?? session.handoffPath;
  const hasHandoff = !!handoffPath;
  const meta = [
    sourceLabel(session.source),
    STATE_LABEL[session.state],
    session.branch,
    session.cwd,
  ].filter(Boolean);

  const tabs: Tab[] = hasHandoff ? ["handoff", "transcript"] : ["transcript"];
  const shownTab: Tab =
    tab === "handoff" && hasHandoff ? "handoff" : "transcript";
  const tabId = (id: Tab) => `${ids}-tab-${id}`;
  const panelId = `${ids}-panel`;
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next =
      tabs[(tabs.indexOf(shownTab) + step + tabs.length) % tabs.length];
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      id={tabId(id)}
      aria-selected={shownTab === id}
      aria-controls={panelId}
      tabIndex={shownTab === id ? 0 : -1}
      onClick={() => setTab(id)}
      className={`rounded-md px-2 py-0.5 text-[12px] font-medium ${
        shownTab === id
          ? "bg-content/10 text-content"
          : "text-content/50 hover:bg-content/5 hover:text-content/80"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Modal
      onClose={onClose}
      title={sessionLabel(session)}
      description={meta.join(" · ")}
      size="lg"
      className="h-[min(720px,calc(100dvh-80px))]"
    >
      <div
        ref={bodyRef}
        data-fork-external-viewer=""
        className="flex min-h-full flex-col gap-3 px-4 pb-4 pt-3"
      >
        <div className="flex items-center gap-1">
          <div
            role="tablist"
            className="flex items-center gap-1"
            onKeyDown={onTabKey}
          >
            {hasHandoff ? tabButton("handoff", "Handoff") : null}
            {tabButton("transcript", "Transcript")}
          </div>
          <span className="ml-auto flex items-center gap-1.5">
            {target.kind === "remote" ? (
              <MoveToMacButton session={session} machineId={target.machineId} />
            ) : null}
            {hasHandoff && cwd ? (
              <button
                type="button"
                data-fork-external-continue=""
                onClick={() => {
                  if (handoffPath && continueFromHandoff(cwd, handoffPath)) {
                    onClose();
                  }
                }}
                className="rounded-md bg-accent/15 px-2 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent/25"
              >
                Continue here
              </button>
            ) : null}
            <button
              type="button"
              disabled={turns.length === 0}
              onClick={() => void copyText(transcriptText(turns))}
              className="rounded-md px-2 py-0.5 text-[12px] font-medium text-content/60 hover:bg-content/8 hover:text-content disabled:opacity-40"
            >
              Copy transcript
            </button>
          </span>
        </div>
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(shownTab)}
          className="flex flex-col gap-3"
        >
          {error ? (
            <p className="text-[12px] text-content/50">
              Could not read this session. {error}
            </p>
          ) : null}
          {shownTab === "handoff" ? (
            handoff ? (
              <AgentMarkdown text={handoff.text} className="text-[13px]" />
            ) : loading ? null : (
              <p className="text-[12px] text-content/45">{handoffPath}</p>
            )
          ) : (
            <div className="flex flex-col gap-3">
              {before != null ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadOlder()}
                  className="self-center rounded-md px-2 py-0.5 text-[12px] text-content/50 hover:bg-content/5 hover:text-content/80"
                >
                  Load older
                </button>
              ) : null}
              {turns.map((turn, index) => (
                <TurnView key={index} turn={turn} />
              ))}
              {!loading && turns.length === 0 && !error ? (
                <p className="text-[12px] text-content/45">
                  {session.hasTranscript
                    ? "No turns yet."
                    : "This session's transcript is not readable."}
                </p>
              ) : null}
              {truncated ? (
                <p className="text-[11px] text-content/40">
                  Some long text was shortened.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
