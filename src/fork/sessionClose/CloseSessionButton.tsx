import { useEffect, useRef, useState } from "react";
import { CheckCheck } from "../../shared/ui/icons";
import {
  AUTO_CLOSE_AFTER_S,
  isKeptOpen,
  keepOpen,
  tickCountdown,
} from "./autoClose";

/**
 * Under a reply that ends "Safe to close" (nothing left, or a handover ready): archives the
 * session in one click. It stays restorable from Archived, so it does not ask.
 * Left alone, it closes the session itself once the reply has been in view for
 * `AUTO_CLOSE_AFTER_S` seconds; "Keep open" stops that for this reply.
 */
export function CloseSessionButton({
  replyKey,
  onClose,
}: {
  /** From `autoCloseKey`: which reply this offer belongs to. */
  replyKey: string;
  onClose: () => Promise<boolean>;
}) {
  const [closing, setClosing] = useState(false);
  const [kept, setKept] = useState(() => isKeptOpen(replyKey));
  const [remaining, setRemaining] = useState(AUTO_CLOSE_AFTER_S);
  const [prevKey, setPrevKey] = useState(replyKey);
  if (prevKey !== replyKey) {
    setPrevKey(replyKey);
    setKept(isKeptOpen(replyKey));
    setRemaining(AUTO_CLOSE_AFTER_S);
  }
  const box = useRef<HTMLDivElement>(null);
  const inView = useRef(false);
  const fired = useRef<string | null>(null);

  const close = () => {
    setClosing(true);
    // On success the pane goes away; on failure App has told the person.
    void onClose().then(
      () => setClosing(false),
      () => setClosing(false),
    );
  };

  // In view: on screen with a size, so not in a hidden tab or scrolled away.
  useEffect(() => {
    const node = box.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      inView.current = entries.some((entry) => entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const counting = !kept && !closing && remaining > 0;
  useEffect(() => {
    if (!counting) {
      return;
    }
    const id = setInterval(() => {
      setRemaining((left) =>
        tickCountdown(left, {
          windowActive:
            document.visibilityState === "visible" && document.hasFocus(),
          inView: inView.current,
        }),
      );
    }, 1000);
    return () => clearInterval(id);
  }, [counting]);

  // One automatic close per reply: a failed archive is not retried on its own.
  useEffect(() => {
    if (remaining === 0 && !kept && fired.current !== replyKey) {
      fired.current = replyKey;
      close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, kept, replyKey]);

  return (
    <div ref={box} className="flex items-center gap-2 px-4 pt-1 pb-1">
      <button
        type="button"
        title="Archive this session; you can restore it from Archived"
        data-fork-safe-close=""
        disabled={closing}
        onClick={close}
        className="flex select-none items-center gap-1.5 rounded-md bg-content/8 px-2 py-1 font-sans text-xs text-content/80 outline-none hover:bg-content/12 hover:text-content focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
      >
        <CheckCheck
          className="size-3.5 text-emerald-400"
          strokeWidth={2}
          aria-hidden="true"
        />
        Close session
      </button>
      {!kept && remaining > 0 ? (
        <>
          <span
            data-fork-auto-close={remaining}
            className="font-sans text-xs tabular-nums text-content/50"
          >
            Closes in {remaining}s
          </span>
          <button
            type="button"
            data-fork-keep-open=""
            onClick={() => {
              keepOpen(replyKey);
              setKept(true);
            }}
            className="select-none rounded-md px-1.5 py-1 font-sans text-xs text-content/60 outline-none hover:bg-content/8 hover:text-content focus-visible:ring-1 focus-visible:ring-accent"
          >
            Keep open
          </button>
        </>
      ) : null}
    </div>
  );
}
