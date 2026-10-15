import { useRef, useState, type ReactNode } from "react";
import type { MarkdownViewMode } from "../../features/sessions/ui/MarkdownModeToggle";
import { clampSplit, type LatexLayout } from "./latexModel";

const SPLIT_KEY = "fork.latex.split";
const LAYOUTS: { id: LatexLayout; label: string }[] = [
  { id: "source", label: "Code" },
  { id: "split", label: "Split" },
  { id: "pdf", label: "PDF" },
];

function loadSplit(): number {
  try {
    return clampSplit(Number(localStorage.getItem(SPLIT_KEY) ?? 0.5));
  } catch {
    return 0.5;
  }
}

/**
 * Fork feature: drop-in for `MarkdownViewShell` on `.tex` files. Shows the
 * source and the compiled PDF side by side, with Code / Split / PDF. Both
 * stay mounted, so the editor keeps its state when one is hidden. `mode` is
 * not used: the editor stays the active "source" side throughout.
 */
export function LatexViewShell({
  preview,
  source,
}: {
  mode: MarkdownViewMode;
  onModeChange: (mode: MarkdownViewMode) => void;
  preview: ReactNode;
  source: ReactNode;
  actions?: ReactNode;
}) {
  const [layout, setLayout] = useState<LatexLayout>("split");
  const [split, setSplit] = useState(loadSplit);
  const [dragging, setDragging] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const onDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!dragging || !row) {
      return;
    }
    const box = row.getBoundingClientRect();
    setSplit(clampSplit((event.clientX - box.left) / box.width));
  };

  const endDrag = () => {
    setDragging(false);
    try {
      localStorage.setItem(SPLIT_KEY, String(split));
    } catch {
      // Remembering the width is a convenience only.
    }
  };

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={rowRef}
        className={`flex min-h-0 flex-1 ${dragging ? "cursor-col-resize select-none" : ""}`}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className={
            layout === "pdf" ? "hidden" : "relative min-h-0 min-w-0 flex-1"
          }
          style={
            layout === "split" ? { flex: `0 0 ${split * 100}%` } : undefined
          }
        >
          {source}
        </div>
        {layout === "split" ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize code and PDF"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onDoubleClick={() => setSplit(0.5)}
            className="w-1 shrink-0 cursor-col-resize border-l border-stroke hover:bg-content/10"
          />
        ) : null}
        <div
          className={
            layout === "source" ? "hidden" : "relative min-h-0 min-w-0 flex-1"
          }
        >
          {preview}
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label="LaTeX layout"
        className="absolute bottom-10 right-3 z-20 flex gap-0.5 rounded-md border border-stroke bg-background-base/90 p-0.5 text-[11px] shadow-sm"
      >
        {LAYOUTS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={layout === entry.id}
            onClick={() => setLayout(entry.id)}
            className={`rounded px-2 py-0.5 ${
              layout === entry.id
                ? "bg-content/10 text-content"
                : "text-content/50 hover:text-content"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>
    </div>
  );
}
