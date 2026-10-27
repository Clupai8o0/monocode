import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

/**
 * The grab zone between two sidebar sections. It takes no height and draws
 * nothing: it lies over the bottom padding of the section above, so that gap
 * is the handle, shown by the cursor. Keyboard focus shows a short grip, and
 * the arrow keys resize.
 */
export function SplitHandle({
  label,
  onPointerDown,
  onDoubleClick,
  onKeyDown,
}: {
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  return (
    <div className="relative h-0 shrink-0">
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        title={`${label} (double-click to reset)`}
        tabIndex={0}
        data-fork-split-handle=""
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        className="absolute inset-x-2 -top-2 z-10 h-2 cursor-row-resize touch-none outline-none after:absolute after:left-1/2 after:top-1/2 after:h-1 after:w-8 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full focus-visible:after:bg-accent/60"
      />
    </div>
  );
}
