import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import { Check, Copy } from "../../../shared/ui/icons";
import { playCue } from "../../settings/model/sounds";

export type MarkdownViewMode = "preview" | "source";

const remembered = new Map<string, MarkdownViewMode>();

export function useMarkdownMode(
  key: string,
  fallback: MarkdownViewMode = "preview",
): [MarkdownViewMode, (mode: MarkdownViewMode) => void] {
  const [mode, setMode] = useState<MarkdownViewMode>(
    () => remembered.get(key) ?? fallback,
  );
  // A changed fallback applies to the next key, not the item already shown.
  const shownKey = useRef(key);

  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    setMode(remembered.get(key) ?? fallback);
  }, [key, fallback]);

  return [
    mode,
    (next) => {
      remembered.set(key, next);
      setMode(next);
    },
  ];
}

type ToggleProps = {
  mode: MarkdownViewMode;
  onChange: (mode: MarkdownViewMode) => void;
};

export function MarkdownModeToggle({ mode, onChange }: ToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Markdown view"
      className="flex rounded-md border border-content/10 bg-content/10 p-0.5 backdrop-blur-md"
    >
      <ModeTab
        label="Preview"
        selected={mode === "preview"}
        onSelect={() => onChange("preview")}
      />
      <ModeTab
        label="Source"
        selected={mode === "source"}
        onSelect={() => onChange("source")}
      />
    </div>
  );
}

function ModeTab({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={`rounded px-2 py-0.5 font-sans text-[11px] ${
        selected
          ? "bg-selection-strong text-content"
          : "text-content/45 hover:text-content/80"
      }`}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

/** Copies a file's whole source; sized and styled to sit beside the switch. */
export function SourceCopyButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      title={copied ? "Copied" : "Copy source"}
      aria-label={copied ? "Copied" : "Copy source"}
      data-source-copy
      className={`flex h-6 items-center gap-1 rounded-md border border-content/10 bg-content/10 px-2 font-sans text-[11px] backdrop-blur-md transition-colors ${
        copied ? "text-content" : "text-content/55 hover:text-content/85"
      } ${className}`}
      onClick={() => {
        playCue("copy");
        void copyText(text).then(
          () => {
            setCopied(true);
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        );
      }}
    >
      {copied ? (
        <Check className="size-3" strokeWidth={1.75} />
      ) : (
        <Copy className="size-3" strokeWidth={1.75} />
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

type ShellProps = {
  mode: MarkdownViewMode;
  onModeChange: (mode: MarkdownViewMode) => void;
  preview: ReactNode;
  source: ReactNode;
  actions?: ReactNode;
  /** The file's full text; shows a Copy button beside the switch. */
  copySource?: string;
};

export function MarkdownViewShell({
  mode,
  onModeChange,
  preview,
  source,
  actions,
  copySource,
}: ShellProps) {
  return (
    <div className="markdown-view-shell relative min-h-0 min-w-0 flex-1">
      <div className="markdown-view-actions pointer-events-none absolute right-2 z-20">
        <div className="pointer-events-auto flex items-center gap-1.5">
          {actions}
          {copySource != null ? <SourceCopyButton text={copySource} /> : null}
          <MarkdownModeToggle mode={mode} onChange={onModeChange} />
        </div>
      </div>
      <div
        data-markdown-view-active={mode === "preview" ? "" : undefined}
        className={
          mode === "preview"
            ? "absolute inset-0"
            : "pointer-events-none invisible absolute inset-0"
        }
      >
        {preview}
      </div>
      <div
        data-markdown-view-active={mode === "source" ? "" : undefined}
        className={
          mode === "source"
            ? "absolute inset-0"
            : "pointer-events-none invisible absolute inset-0"
        }
      >
        {source}
      </div>
    </div>
  );
}
