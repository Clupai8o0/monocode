import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Check, Loader, RotateCcw } from "../../shared/ui/icons";
import { watchFile } from "../../features/files/model/fileWatch";
import { displayPath } from "../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../shared/lib/remotePaths";
import type { OpenFileFn } from "../../features/search/model/search";
import { PdfView } from "../pdf/PdfView";
import { useShownGate } from "../shows/shownPaths";
import { formatMillis, issueLabel, type LatexResult } from "./latexModel";

const ENABLED = import.meta.env.MODE !== "test";
/** Saves arrive as a burst of change events; build once they settle. */
const SAVE_SETTLE_MS = 300;

/**
 * Fork feature: the PDF side of a `.tex` file. Builds on open and on every
 * save (of this file, or of the `% !TEX root` it belongs to), shows the
 * errors with clickable lines, and keeps the last good PDF up meanwhile.
 */
export function LatexPreview({
  path,
  cwd,
  onOpenFile,
}: {
  path: string;
  cwd: string;
  onOpenFile?: OpenFileFn;
}) {
  const [result, setResult] = useState<LatexResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [version, setVersion] = useState(0);
  const [showIssues, setShowIssues] = useState(true);
  const running = useRef(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const remote = path.startsWith(REMOTE_PATH_PREFIX);
  // A file sent from another machine compiles only after a click, and then
  // TeX may not read or write outside its folder.
  const gate = useShownGate(path);
  const shown = gate.shown;
  const blocked = remote || gate.blocked;

  const build = useCallback(async () => {
    if (!ENABLED || blocked) {
      return;
    }
    if (running.current) {
      pending.current = true;
      return;
    }
    running.current = true;
    setBuilding(true);
    try {
      do {
        pending.current = false;
        try {
          const next = await invoke<LatexResult>("fork_latex_compile", {
            path,
            cwd,
            ...(shown ? { paranoid: true } : {}),
          });
          if (!alive.current) {
            return;
          }
          setResult(next);
          setFailure(null);
          if (next.pdf) {
            setVersion((value) => value + 1);
          }
        } catch (cause) {
          if (alive.current) {
            setFailure(cause instanceof Error ? cause.message : String(cause));
          }
        }
      } while (pending.current && alive.current);
    } finally {
      running.current = false;
      if (alive.current) {
        setBuilding(false);
      }
    }
  }, [path, cwd, blocked, shown]);

  useEffect(() => {
    alive.current = true;
    void build();
    return () => {
      alive.current = false;
    };
  }, [build]);

  // Rebuild when this file or its root is saved.
  const root = result?.root;
  useEffect(() => {
    if (!ENABLED || blocked) {
      return;
    }
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void build(), SAVE_SETTLE_MS);
    };
    const stops = [watchFile(path, onChange)];
    if (root && root !== path) {
      stops.push(watchFile(root, onChange));
    }
    return () => {
      window.clearTimeout(timer);
      for (const stop of stops) {
        stop();
      }
    };
  }, [path, root, blocked, build]);

  if (remote) {
    return (
      <Message>The LaTeX preview works for files on this Mac only.</Message>
    );
  }
  if (gate.blocked) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm text-center text-[12px] leading-5 text-content/60">
          Sent from another machine. Compiling runs LaTeX on this Mac.
          <button
            type="button"
            onClick={gate.allow}
            className="mx-auto mt-3 block rounded-md bg-content/10 px-2 py-1 text-[12px] text-content/80 hover:bg-content/15"
          >
            Compile on this Mac
          </button>
        </div>
      </div>
    );
  }
  if (result?.status === "no-tex") {
    return (
      <Message>
        LaTeX isn’t installed. Install MacTeX with{" "}
        <code className="rounded bg-content/10 px-1 font-mono">
          brew install --cask mactex-no-gui
        </code>
        , then reopen this file.
      </Message>
    );
  }
  if (result?.status === "not-root") {
    return (
      <Message>
        This file has no <code className="font-mono">\documentclass</code>. If
        it is part of a bigger document, add{" "}
        <code className="rounded bg-content/10 px-1 font-mono">
          % !TEX root = main.tex
        </code>{" "}
        as its first line.
      </Message>
    );
  }

  const errors = result?.errors ?? [];
  const notes = result?.notes ?? [];
  const hasIssues = errors.length > 0 || notes.length > 0 || !!result?.logTail;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-stroke px-3 text-[11px] text-content/55">
        {building ? (
          <>
            <Loader className="size-3 animate-spin" />
            <span>Building…</span>
          </>
        ) : failure ? (
          <>
            <AlertCircle className="size-3 text-red-400" />
            <span className="truncate text-red-300">{failure}</span>
          </>
        ) : result?.status === "ok" ? (
          <>
            <Check className="size-3 text-emerald-400" />
            <span>
              Built with {result.engine} in {formatMillis(result.millis)}
            </span>
          </>
        ) : result ? (
          <button
            type="button"
            onClick={() => setShowIssues((value) => !value)}
            className="flex items-center gap-1.5 text-red-300 hover:text-red-200"
          >
            <AlertCircle className="size-3" />
            {errors.length > 0
              ? `${errors.length} ${errors.length === 1 ? "error" : "errors"}`
              : "Build failed"}
          </button>
        ) : null}
        {result && result.warnings > 0 ? (
          <span className="text-amber-300/80">
            {result.warnings} {result.warnings === 1 ? "warning" : "warnings"}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void build()}
          disabled={building}
          title="Build again"
          className="flex items-center gap-1 rounded px-1 hover:text-content disabled:opacity-40"
        >
          <RotateCcw className="size-3" strokeWidth={1.75} />
          Rebuild
        </button>
      </div>

      {result && hasIssues && showIssues && result.status !== "ok" ? (
        <div className="max-h-48 shrink-0 overflow-y-auto border-b border-stroke bg-red-500/5 py-1 text-[12px]">
          {errors.map((issue, index) => {
            const label = issueLabel(issue, result.root);
            return (
              <button
                key={index}
                type="button"
                disabled={!issue.file || !onOpenFile}
                onClick={() =>
                  issue.file &&
                  onOpenFile?.(
                    issue.file,
                    issue.line ? { line: issue.line } : undefined,
                  )
                }
                className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-content/5 disabled:hover:bg-transparent"
              >
                {label ? (
                  <span className="shrink-0 font-mono text-[11px] text-red-300/90 underline decoration-dotted">
                    {label}
                  </span>
                ) : null}
                <span className="min-w-0 break-words text-content/80">
                  {issue.message}
                </span>
              </button>
            );
          })}
          {notes.map((note, index) => (
            <p key={`note-${index}`} className="px-3 py-0.5 text-amber-300/80">
              {note}
            </p>
          ))}
          {errors.length === 0 && result.logTail ? (
            <pre className="whitespace-pre-wrap px-3 py-1 font-mono text-[11px] text-content/60">
              {result.logTail}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {result?.pdf ? (
          <PdfView
            path={result.pdf}
            cwd={cwd}
            watch={false}
            version={version}
            referenceName={`${displayPath(path, cwd)} PDF`}
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-content/45">
            {building || !result
              ? "Building the PDF…"
              : "No PDF yet: fix the errors above and save."}
          </div>
        )}
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <p className="max-w-sm text-center text-[12px] leading-5 text-content/60">
        {children}
      </p>
    </div>
  );
}
