import { useEffect, useState, type ReactNode } from "react";
import type { MarkdownViewMode } from "../../features/sessions/ui/MarkdownModeToggle";

/** Keeps the source editor mounted; hidden previews stop their scripts. */
export function HtmlViewShell({
  mode,
  onModeChange,
  preview,
  source,
  navigationToken,
}: {
  mode: MarkdownViewMode;
  onModeChange: (mode: MarkdownViewMode) => void;
  preview: ReactNode;
  source: ReactNode;
  navigationToken?: number;
}) {
  const [split, setSplit] = useState(false);
  useEffect(() => setSplit(false), [navigationToken]);
  const layout = split ? "split" : mode;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-html-view-shell=""
    >
      <div className="flex h-8 shrink-0 items-center justify-end border-b border-stroke px-2">
        <div
          role="tablist"
          aria-label="HTML view"
          className="flex gap-0.5 rounded-md bg-content/5 p-0.5 text-[11px]"
        >
          {(
            [
              { id: "source", label: "Code" },
              { id: "split", label: "Split" },
              { id: "preview", label: "Preview" },
            ] as const
          ).map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={layout === entry.id}
              onClick={() => {
                setSplit(entry.id === "split");
                onModeChange(entry.id === "preview" ? "preview" : "source");
              }}
              className={`rounded px-2 py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-accent ${layout === entry.id ? "bg-content/10 text-content" : "text-content/50 hover:text-content"}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        <div
          className={
            layout === "preview" ? "hidden" : "relative min-h-0 min-w-0 flex-1"
          }
        >
          {source}
        </div>
        {layout !== "source" ? (
          <div
            className={`relative min-h-0 min-w-0 flex-1 ${split ? "border-l border-stroke" : ""}`}
          >
            {preview}
          </div>
        ) : null}
      </div>
    </div>
  );
}
