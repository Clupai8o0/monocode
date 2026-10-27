import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { suppressTextSelection } from "../../shared/lib/drag";

/**
 * Fork feature: drag the inset sidebar's sections taller or shorter. A
 * section without a saved height keeps its own CSS cap; dragging sets one,
 * and a double-click on the handle goes back to the cap.
 */

const PREFIX = "monocode.fork.sidebar.";
const KEY_STEP = 16;

/** A saved size in px, or null when none is saved or it is unreadable. */
export function loadStoredSize(name: string): number | null {
  try {
    const raw = localStorage.getItem(PREFIX + name);
    if (raw == null) {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  } catch {
    return null;
  }
}

export function saveStoredSize(name: string, value: number | null) {
  try {
    if (value == null) {
      localStorage.removeItem(PREFIX + name);
    } else {
      localStorage.setItem(PREFIX + name, String(Math.round(value)));
    }
  } catch {
    // Storage blocked: the size still holds for this run.
  }
}

export function clampSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(min, max), Math.max(min, value)));
}

/**
 * Height for one section. `max` is read when a drag starts, so it can
 * measure the space the sections below still need. `cap` is the largest
 * share of the parent's height it may take, also kept as a CSS max-height so
 * a saved height can't crowd the rest out in a smaller window.
 */
export function useHeightSplit({
  name,
  min,
  max,
  cap,
}: {
  name: string;
  min: number;
  max: (pane: HTMLElement) => number;
  /** 0 to 1. */
  cap: number;
}) {
  const [height, setHeight] = useState<number | null>(() =>
    loadStoredSize(name),
  );
  const heightRef = useRef(height);
  heightRef.current = height;
  const [dragging, setDragging] = useState(false);
  const paneRef = useRef<HTMLElement | null>(null);
  const maxRef = useRef(max);
  maxRef.current = max;
  const stopDrag = useRef<(() => void) | null>(null);

  const setPaneRef = useCallback((el: HTMLElement | null) => {
    paneRef.current = el;
  }, []);

  const maxHeight = `${cap * 100}%`;
  // The drag stops where the CSS cap does, so a saved height is one it shows.
  const limitFor = (pane: HTMLElement) => {
    const parent = pane.parentElement?.getBoundingClientRect().height ?? 0;
    const measured = maxRef.current(pane);
    return parent > 0 ? Math.min(measured, parent * cap) : measured;
  };

  const commit = useCallback(
    (next: number | null) => {
      setHeight(next);
      saveStoredSize(name, next);
    },
    [name],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    const pane = paneRef.current;
    if (event.button !== 0 || !pane) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const startHeight = pane.getBoundingClientRect().height;
    const limit = limitFor(pane);
    let next = startHeight;
    let moved = false;
    handle.setPointerCapture(pointerId);
    // Held at its size while the CSS cap gives way, so a press doesn't jump.
    pane.style.height = `${startHeight}px`;
    setDragging(true);
    const restoreSelection = suppressTextSelection();
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "row-resize";
    document.documentElement.classList.add("is-resizing");

    // Written straight to the DOM once a frame, so renders can't fight it.
    let frame = 0;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) {
        return;
      }
      moved = true;
      next = clampSize(startHeight + ev.clientY - startY, min, limit);
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        pane.style.height = `${next}px`;
      });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) {
        stop();
      }
    };
    const stop = () => {
      if (stopDrag.current !== stop) {
        return;
      }
      stopDrag.current = null;
      if (frame) {
        cancelAnimationFrame(frame);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      restoreSelection();
      document.body.style.cursor = previousCursor;
      document.documentElement.classList.remove("is-resizing");
      setDragging(false);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
      // A committed height renders over the drag's inline style; a click
      // without a move hands the style back to React.
      if (moved && Math.abs(next - startHeight) >= 1) {
        commit(next);
      } else {
        const saved = heightRef.current;
        pane.style.height = saved == null ? "" : `${saved}px`;
      }
    };
    stopDrag.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  useEffect(() => () => stopDrag.current?.(), []);

  const onDoubleClick = () => {
    commit(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const pane = paneRef.current;
    if (!pane || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    event.preventDefault();
    const current = pane.getBoundingClientRect().height;
    const step = event.key === "ArrowUp" ? -KEY_STEP : KEY_STEP;
    const next = clampSize(current + step, min, limitFor(pane));
    // Out of room, a key goes nowhere rather than against its arrow.
    if (Math.sign(next - current) === Math.sign(step)) {
      commit(next);
    }
  };

  return {
    height,
    dragging,
    /** False once a height is saved or a drag is on: the section's own CSS
     * cap gives way to `style`, and a saved height may shrink down to `min`
     * when the window is too short for it. */
    capped: height == null && !dragging,
    style:
      height != null
        ? { height: `${height}px`, maxHeight, minHeight: `${min}px` }
        : dragging
          ? { maxHeight }
          : undefined,
    setPaneRef,
    onPointerDown,
    onDoubleClick,
    onKeyDown,
  };
}
