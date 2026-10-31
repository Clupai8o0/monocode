import { useCallback, useEffect, useRef, useState } from "react";
import { firstRangeRect } from "../../features/sessions/hooks/useTranscriptSelection";
import type { TranscriptSelection } from "../../features/sessions/model/transcriptSelection";
import type { AskChatDescribe } from "./askChatDescribe";
import { quoteForChat } from "./askChatModel";

/** Off under the test runner, like the neighbouring fork watchers. */
export const ASK_CHAT_ENABLED = import.meta.env.MODE !== "test";

/**
 * A paragraph selected whole ends at the start of whatever follows it. If that
 * is outside the view and adds no text, pull the end back inside.
 */
function clampToRoot(range: Range, root: HTMLElement): Range {
  if (root.contains(range.endContainer)) return range;
  if (!root.contains(range.startContainer)) return range;
  const overflow = range.cloneRange();
  overflow.setStartAfter(root.lastChild ?? root);
  if (overflow.toString().trim()) return range;
  const clamped = range.cloneRange();
  clamped.selectNodeContents(root);
  clamped.setStart(range.startContainer, range.startOffset);
  return clamped;
}

/** What the current selection would send from this view, if it is in it. */
export type AskChatSelection = TranscriptSelection & { cells?: Element[] };

export function readAskChatSelection(
  selection: Selection | null,
  root: HTMLElement,
  describe: AskChatDescribe,
): AskChatSelection | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = clampToRoot(selection.getRangeAt(0), root);
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return null;
  }
  const selected = selection.toString();
  if (!selected.trim()) return null;
  const description = describe(range, root);
  if (!description) return null;
  const text = quoteForChat(
    description.reference,
    description.text ?? selected,
    description.text !== undefined,
  );
  const rect = text ? firstRangeRect(range) : null;
  return text && rect ? { text, rect, cells: description.cells } : null;
}

/**
 * The transcript's selection timing for any view showing a file's content: it
 * waits for the pointer to lift, follows the keyboard, and reports only a
 * selection wholly inside `root`, so split panes do not answer for each other.
 */
export function useAskChatSelection(
  root: HTMLElement | null,
  describe: AskChatDescribe,
  enabled: boolean = ASK_CHAT_ENABLED,
): {
  selection: AskChatSelection | null;
  dismissSelection: () => void;
} {
  const [selection, setSelection] = useState<AskChatSelection | null>(null);
  const describeRef = useRef(describe);
  describeRef.current = describe;
  const dismissSelection = useCallback(() => setSelection(null), []);

  useEffect(() => {
    if (!enabled || !root) {
      setSelection(null);
      return;
    }
    let frame: number | null = null;
    let pointerSelecting = false;
    const cancelFrame = () => {
      if (frame == null) return;
      window.cancelAnimationFrame(frame);
      frame = null;
    };
    const report = () => {
      frame = null;
      setSelection(
        readAskChatSelection(window.getSelection(), root, describeRef.current),
      );
    };
    const schedule = () => {
      cancelFrame();
      frame = window.requestAnimationFrame(report);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerSelecting = root.contains(event.target as Node);
      if (pointerSelecting) cancelFrame();
    };
    const onPointerUp = () => {
      if (!pointerSelecting) return;
      pointerSelecting = false;
      schedule();
    };
    const onPointerCancel = () => {
      pointerSelecting = false;
    };
    const onSelectionChange = () => {
      if (!pointerSelecting) schedule();
    };
    document.addEventListener("pointerdown", onPointerDown, { passive: true });
    document.addEventListener("pointerup", onPointerUp, { passive: true });
    document.addEventListener("pointercancel", onPointerCancel, {
      passive: true,
    });
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      cancelFrame();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [enabled, root]);

  return { selection, dismissSelection };
}
