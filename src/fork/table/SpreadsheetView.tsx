import { useCallback, useEffect, useState } from "react";
import { AlertCircle } from "../../shared/ui/icons";
import { formatFileSize } from "../../features/files/model/filePreview";
import { watchFile } from "../../features/files/model/fileWatch";
import {
  basename,
  openPathWithDefaultApp,
  readBinaryFile,
  REMOTE_PATH_PREFIX,
} from "../../platform/tauri/fs";
import { displayPath } from "../../shared/lib/paths";
import { TableGrid } from "./TableGrid";
import { readWorkbook, type Sheet } from "./xlsx";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; sheets: Sheet[]; size: number }
  | { status: "error"; message: string };

/**
 * Fork feature: read-only Excel preview. The workbook is unzipped and read in
 * the webview; nothing runs (macros in `.xlsm` are never touched) and nothing
 * is written back.
 */
export function SpreadsheetView({ path, cwd }: { path: string; cwd: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bytes = await readBinaryFile(path);
      const sheets = await readWorkbook(bytes);
      if (!cancelled) {
        setState({ status: "ready", sheets, size: bytes.byteLength });
      }
    })().catch((cause: unknown) => {
      if (!cancelled) {
        setState({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    let timer = 0;
    const stop = watchFile(path, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 200);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [path, reload]);

  const openExternally = path.startsWith(REMOTE_PATH_PREFIX) ? null : (
    <button
      type="button"
      onClick={() => void openPathWithDefaultApp(path).catch(() => {})}
      className="rounded px-1 hover:text-content"
    >
      Open externally
    </button>
  );

  if (state.status === "loading") {
    return (
      <div className="grid h-full place-items-center text-[12px] text-content/45">
        Opening {basename(path)}…
      </div>
    );
  }

  if (state.status === "error" || state.sheets.length === 0) {
    const message =
      state.status === "error" ? state.message : "The workbook has no sheets.";
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="mx-auto mb-3 size-5 text-red-400" />
          <p className="text-[13px] text-content">
            Couldn’t open {basename(path)}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-content/50">
            {message}
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-content/35">
            {displayPath(path, cwd)}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2 text-[12px] text-content/60">
            <button
              type="button"
              onClick={reload}
              className="flex h-7 items-center rounded-md bg-content/10 px-2.5 text-content hover:bg-content/15"
            >
              Try again
            </button>
            {openExternally}
          </div>
        </div>
      </div>
    );
  }

  const index = Math.min(active, state.sheets.length - 1);
  const sheet = state.sheets[index];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <TableGrid
          key={`${index}:${reloadKey}`}
          rows={sheet.rows}
          label={`Spreadsheet preview: ${basename(path)}, ${sheet.name}`}
          file={displayPath(path, cwd)}
          sheet={sheet.name}
          footer={
            <>
              {sheet.truncated ? (
                <span className="text-amber-400/80">Cut short</span>
              ) : null}
              <span className="tabular-nums">{formatFileSize(state.size)}</span>
              <span className="flex-1" />
              {openExternally}
            </>
          }
        />
      </div>
      {state.sheets.length > 1 ? (
        <div
          role="tablist"
          aria-label="Sheets"
          className="flex h-8 shrink-0 items-stretch gap-0.5 overflow-x-auto border-t border-stroke px-2 text-[12px]"
        >
          {state.sheets.map((entry, sheetIndex) => (
            <button
              key={sheetIndex}
              type="button"
              role="tab"
              aria-selected={sheetIndex === index}
              onClick={() => setActive(sheetIndex)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 ${
                sheetIndex === index
                  ? "border-content/70 text-content"
                  : "border-transparent text-content/50 hover:text-content"
              }`}
            >
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
