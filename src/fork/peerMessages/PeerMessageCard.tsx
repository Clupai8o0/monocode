import type { HarnessId } from "../../features/sessions/model/session";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { formatPeerTime, type PeerMessage } from "./peerMessage";

/**
 * A message another session sent into this chat. It sits in the transcript
 * like a quiet note: the sender's agent mark and name, when it came in, and
 * the text. Amber is kept for messages marked urgent, so a routine status
 * update does not read as an alarm.
 */
export function PeerMessageCard({
  message,
  harness = "claude",
  at,
  urgent = false,
  onOpen,
}: {
  message: PeerMessage;
  /** Agent the sender runs on, when the envelope identifies it. */
  harness?: HarnessId;
  /** Arrival time, epoch ms. */
  at?: number;
  urgent?: boolean;
  /** Opens the sender's session. The button is hidden without it. */
  onOpen?: () => void;
}) {
  const time = at == null ? null : formatPeerTime(at);
  return (
    <article
      data-peer-message={message.name}
      data-urgent={urgent ? "true" : undefined}
      aria-label={`Message from ${message.name}`}
      className={`w-fit max-w-[min(100%,36rem)] min-w-[min(100%,18rem)] rounded-xl border px-3 pt-2 pb-2.5 font-sans ${
        urgent
          ? "border-amber-400/35 bg-amber-400/[0.06]"
          : "border-content/10 bg-content/[0.04]"
      }`}
    >
      <header className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-md bg-content/[0.07]"
        >
          <HarnessIcon harness={harness} className="size-3.5" />
        </span>
        <span
          className="min-w-0 truncate font-medium text-content/85"
          title={message.from}
        >
          {message.name}
        </span>
        <span className="shrink-0 text-content/45">
          {urgent ? (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              Urgent ·{" "}
            </span>
          ) : null}
          from another session
          {time ? (
            <>
              {" · "}
              <time
                className="tabular-nums"
                dateTime={new Date(at as number).toISOString()}
              >
                {time}
              </time>
            </>
          ) : null}
        </span>
        {onOpen ? (
          <button
            type="button"
            aria-label={`Open session ${message.name}`}
            onClick={onOpen}
            className="-mr-1 ml-auto shrink-0 rounded-md px-2 py-0.5 text-content/55 outline-none transition-[background-color,color] duration-150 hover:bg-content/8 hover:text-content/85 focus-visible:ring-1 focus-visible:ring-accent active:bg-content/12"
          >
            Open session
          </button>
        ) : null}
      </header>
      <p className="mt-1 whitespace-pre-wrap break-words pl-7 text-sm leading-relaxed text-content/90">
        {message.body}
      </p>
    </article>
  );
}
