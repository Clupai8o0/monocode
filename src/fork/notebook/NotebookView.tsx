import { memo, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AlertCircle } from "../../shared/ui/icons";
import { AgentMarkdown } from "../../features/sessions/ui/AgentMarkdown";
import {
  fenced,
  parseNotebook,
  type NotebookCell,
  type NotebookOutput,
} from "./notebookModel";

type OpenFileFn = Parameters<typeof AgentMarkdown>[0]["onOpenFile"];

/** Text outputs longer than this start folded. */
const FOLDED_LINES = 40;

/**
 * Fork feature: the Preview side of a `.ipynb` file. Read-only: cells show
 * with their saved outputs; nothing runs. HTML and JavaScript outputs are
 * never rendered (they could run script in the app); their plain-text twin
 * shows instead.
 */
export function NotebookView({
  source,
  cwd,
  onOpenFile,
}: {
  source: string;
  cwd: string;
  onOpenFile?: OpenFileFn;
}) {
  const text = useDeferredValue(source);
  const parsed = useMemo(() => {
    try {
      return { notebook: parseNotebook(text) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [text]);

  if ("error" in parsed) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="mx-auto mb-3 size-5 text-red-400" />
          <p className="text-[13px] text-content">Can’t show this notebook</p>
          <p className="mt-1 text-[12px] leading-5 text-content/50">
            {parsed.error} Switch to Source to see the file.
          </p>
        </div>
      </div>
    );
  }

  const { notebook } = parsed;
  const codeCells = notebook.cells.filter((cell) => cell.kind === "code");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-label="Notebook preview"
        role="region"
        tabIndex={0}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-6">
          {notebook.cells.length === 0 ? (
            <p className="text-center text-[12px] text-content/45">
              Empty notebook
            </p>
          ) : null}
          {notebook.cells.map((cell, index) => (
            <Cell
              key={index}
              cell={cell}
              language={notebook.language}
              cwd={cwd}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-stroke px-3 text-[11px] text-content/50">
        <span className="tabular-nums">
          {notebook.cells.length} cells · {codeCells.length} code
        </span>
        <span className="capitalize">{notebook.language}</span>
        <span className="flex-1" />
        <span>Read-only · outputs as last saved</span>
      </footer>
    </div>
  );
}

const Cell = memo(function Cell({
  cell,
  language,
  cwd,
  onOpenFile,
}: {
  cell: NotebookCell;
  language: string;
  cwd: string;
  onOpenFile?: OpenFileFn;
}) {
  if (cell.kind === "markdown") {
    return (
      <div className="flex gap-3">
        <Gutter />
        <div className="min-w-0 flex-1 text-[14px]">
          <AgentMarkdown text={cell.source} cwd={cwd} onOpenFile={onOpenFile} />
        </div>
      </div>
    );
  }

  if (cell.kind === "raw") {
    return (
      <div className="flex gap-3">
        <Gutter label="Raw" />
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap rounded-md bg-content/5 px-3 py-2 font-mono text-[12px] text-content/70">
          {cell.source}
        </pre>
      </div>
    );
  }

  const count = cell.executionCount ?? " ";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-3">
        <Gutter label={`In [${count}]`} />
        <div className="min-w-0 flex-1 rounded-md border border-stroke text-[13px] [&_pre]:my-0">
          <AgentMarkdown text={fenced(cell.source, language)} />
        </div>
      </div>
      {cell.outputs.length > 0 ? (
        <div className="flex gap-3">
          <Gutter
            label={cell.executionCount !== null ? `Out [${count}]` : ""}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {cell.outputs.map((output, index) => (
              <Output key={index} output={output} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
});

function Gutter({ label = "" }: { label?: string }) {
  return (
    <div className="w-16 shrink-0 pt-1.5 text-right font-mono text-[11px] tabular-nums text-content/35">
      {label}
    </div>
  );
}

function Output({ output }: { output: NotebookOutput }) {
  switch (output.kind) {
    case "text":
      return (
        <FoldedText
          text={output.text}
          className={
            output.stream === "stderr"
              ? "bg-red-500/10 text-red-300"
              : "text-content/80"
          }
        />
      );
    case "error":
      return (
        <FoldedText text={output.text} className="bg-red-500/10 text-red-300" />
      );
    case "markdown":
      return (
        <div className="min-w-0 text-[13px]">
          <AgentMarkdown text={output.text} />
        </div>
      );
    case "image":
      return (
        <img
          src={output.src}
          alt=""
          className="max-w-full self-start rounded bg-white"
        />
      );
    case "svg":
      return <SvgOutput source={output.source} />;
    case "hidden":
      return (
        <p className="text-[12px] italic text-content/40">
          Output not shown ({output.mimes.join(", ") || "empty"}): open the
          notebook in Jupyter to see it.
        </p>
      );
  }
}

function FoldedText({ text, className }: { text: string; className: string }) {
  const lines = useMemo(() => text.split("\n"), [text]);
  const [open, setOpen] = useState(false);
  const folded = !open && lines.length > FOLDED_LINES;
  return (
    <div className="min-w-0">
      <pre
        className={`overflow-x-auto whitespace-pre rounded-md px-3 py-1.5 font-mono text-[12px] leading-5 ${className}`}
      >
        {folded ? lines.slice(0, FOLDED_LINES).join("\n") : text}
      </pre>
      {lines.length > FOLDED_LINES ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-1 rounded px-1 text-[11px] text-content/50 hover:text-content"
        >
          {folded ? `Show all ${lines.length} lines` : "Fold"}
        </button>
      ) : null}
    </div>
  );
}

/** Same rule as the SVG file preview: an `<img>`, so no script runs. */
function SvgOutput({ source }: { source: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(
      new Blob([source], { type: "image/svg+xml" }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);
  return url ? (
    <img src={url} alt="" className="max-w-full self-start rounded bg-white" />
  ) : null;
}
