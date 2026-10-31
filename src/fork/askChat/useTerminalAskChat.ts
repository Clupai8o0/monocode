import { useCallback, useEffect, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TranscriptSelection } from "../../features/sessions/model/transcriptSelection";
import { quoteForChat } from "./askChatModel";
import { ASK_CHAT_ENABLED } from "./useAskChatSelection";

export const TERMINAL_REFERENCE = "Terminal output";

/**
 * Terminal text is drawn, not DOM text, so the page has no selection to read:
 * this follows xterm's own and places the menu where the pointer lifted. Call
 * it after the effect that creates the terminal, so `termRef` is set.
 */
export function useTerminalAskChat(
  outerRef: RefObject<HTMLElement | null>,
  termRef: RefObject<Terminal | null>,
  id: string,
  enabled: boolean = ASK_CHAT_ENABLED,
): {
  selection: TranscriptSelection | null;
  dismissSelection: () => void;
  clearSelection: () => void;
} {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const dismissSelection = useCallback(() => setSelection(null), []);
  const clearSelection = useCallback(
    () => termRef.current?.clearSelection(),
    [termRef],
  );

  useEffect(() => {
    const outer = outerRef.current;
    const term = termRef.current;
    if (!enabled || !outer || !term) return;
    let pressed = false;
    let frame = 0;
    const onPointerDown = () => {
      pressed = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!pressed) return;
      pressed = false;
      const { clientX, clientY } = event;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const text = quoteForChat(TERMINAL_REFERENCE, term.getSelection());
        setSelection(
          text ? { text, rect: new DOMRect(clientX, clientY, 0, 0) } : null,
        );
      });
    };
    const changes = term.onSelectionChange(() => {
      if (!term.hasSelection()) {
        setSelection(null);
      } else if (!pressed) {
        // Select All and the like: no pointer to place the menu by, so it
        // opens at the top of the terminal, or keeps its place if already open.
        const text = quoteForChat(TERMINAL_REFERENCE, term.getSelection());
        const box = outer.getBoundingClientRect();
        setSelection((open) =>
          text
            ? {
                text,
                rect:
                  open?.rect ??
                  new DOMRect(box.left + box.width / 2, box.top + 8, 0, 0),
              }
            : open,
        );
      }
    });
    outer.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      window.cancelAnimationFrame(frame);
      changes.dispose();
      outer.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
    };
  }, [enabled, id, outerRef, termRef]);

  return { selection, dismissSelection, clearSelection };
}
