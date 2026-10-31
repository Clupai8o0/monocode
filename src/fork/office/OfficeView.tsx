import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Loader, RotateCcw } from "../../shared/ui/icons";
import { watchFile } from "../../features/files/model/fileWatch";
import { openPathWithDefaultApp } from "../../platform/tauri/fs";
import { displayPath } from "../../shared/lib/paths";
import { REMOTE_PATH_PREFIX } from "../../shared/lib/remotePaths";
import { PdfView } from "../pdf/PdfView";
import { formatMillis } from "../latex/latexModel";
import { useShownGate } from "../shows/shownPaths";
import type { OfficeResult } from "./officeModel";

const ENABLED = import.meta.env.MODE !== "test";
const SAVE_SETTLE_MS = 500;

/**
 * Fork feature: read-only preview of Word, PowerPoint and OpenDocument
 * files. LibreOffice turns the file into a PDF in the background, and the
 * fork's PDF view shows it. Converts again when the file changes.
 */
export function OfficeView({ path, cwd }: { path: string; cwd: string }) {
  const [result, setResult] = useState<OfficeResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const running = useRef(false);
  const pending = useRef(false);
  const alive = useRef(true);
  const remote = path.startsWith(REMOTE_PATH_PREFIX);
  // A file sent from another machine converts only after a click.
  const gate = useShownGate(path);
  const blocked = remote || gate.blocked;

  const convert = useCallback(async () => {
    if (!ENABLED || blocked) {
      return;
    }
    if (running.current) {
      pending.current = true;
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      do {
        pending.current = false;
        try {
          const next = await invoke<OfficeResult>("fork_office_convert", {
            path,
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
        setBusy(false);
      }
    }
  }, [path, blocked]);

  useEffect(() => {
    alive.current = true;
    void convert();
    return () => {
      alive.current = false;
    };
  }, [convert]);

  useEffect(() => {
    if (!ENABLED || blocked) {
      return;
    }
    let timer = 0;
    const stop = watchFile(path, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void convert(), SAVE_SETTLE_MS);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [path, blocked, convert]);

  if (remote) {
    return <Message>Office previews work for files on this Mac only.</Message>;
  }
  if (gate.blocked) {
    return (
      <Message>
        Sent from another machine. Converting runs LibreOffice on this Mac.
        <button
          type="button"
          onClick={gate.allow}
          className="mx-auto mt-3 block rounded-md bg-content/10 px-2 py-1 text-[12px] text-content/80 hover:bg-content/15"
        >
          Convert on this Mac
        </button>
      </Message>
    );
  }
  if (result?.status === "no-office") {
    return (
      <Message>
        Previewing Word and PowerPoint files needs LibreOffice. Install it with{" "}
        <code className="rounded bg-content/10 px-1 font-mono">
          brew install --cask libreoffice
        </code>
        , then reopen this file.
        <OpenButton path={path} />
      </Message>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-stroke px-3 text-[11px] text-content/55">
        {busy ? (
          <>
            <Loader className="size-3 animate-spin" />
            <span>Converting with LibreOffice…</span>
          </>
        ) : failure || result?.status === "failed" ? (
          <>
            <AlertCircle className="size-3 text-red-400" />
            <span className="truncate text-red-300">
              {failure ?? result?.message}
            </span>
          </>
        ) : result ? (
          <span>
            Preview made by LibreOffice
            {result.cached ? "" : ` in ${formatMillis(result.millis)}`} · layout
            may differ from Office
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => void openPathWithDefaultApp(path)}
          className="rounded px-1 hover:text-content"
        >
          Open in app
        </button>
        <button
          type="button"
          onClick={() => void convert()}
          disabled={busy}
          title="Convert again"
          className="flex items-center gap-1 rounded px-1 hover:text-content disabled:opacity-40"
        >
          <RotateCcw className="size-3" strokeWidth={1.75} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {result?.pdf ? (
          <PdfView
            path={result.pdf}
            cwd={cwd}
            watch={false}
            version={version}
            referenceName={displayPath(path, cwd)}
          />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-content/45">
            {busy || !result ? "Making the preview…" : "No preview."}
          </div>
        )}
      </div>
    </div>
  );
}

function OpenButton({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => void openPathWithDefaultApp(path)}
      className="mx-auto mt-3 block rounded-md border border-stroke px-2 py-1 text-[12px] text-content/80 hover:bg-content/5"
    >
      Open in default app
    </button>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-sm text-center text-[12px] leading-5 text-content/60">
        {children}
      </div>
    </div>
  );
}
