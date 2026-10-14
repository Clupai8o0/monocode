import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { AlertCircle, Minus, Plus, RotateCcw } from "../../shared/ui/icons";
import { formatFileSize } from "../../features/files/model/filePreview";
import { watchFile } from "../../features/files/model/fileWatch";
import {
  basename,
  openPathWithDefaultApp,
  readBinaryFile,
  REMOTE_PATH_PREFIX,
} from "../../platform/tauri/fs";
import { displayPath } from "../../shared/lib/paths";
import { claimTrackpadMagnify } from "../../platform/tauri/trackpadZoom";
import { resolveZoomKeybinding } from "../../features/settings/model/zoomKeybinding";
import { openPdf } from "./pdfDocument";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;
const PAGE_GAP = 12;
const PADDING = 16;

/** Page sizes in PDF points at scale 1. */
type PageSize = { width: number; height: number };

type LoadState =
  | { status: "loading" }
  | { status: "ready"; doc: PDFDocumentProxy; pages: PageSize[]; size: number }
  | { status: "error"; message: string };

type Props = { path: string; cwd: string };

/**
 * Fork feature: read-only PDF preview. Pages are drawn onto canvases by
 * pdf.js, so the PDF never becomes a document in the webview and the CSP
 * stays as it is (`frame-src 'none'`, `object-src 'none'`).
 */
export function PdfView({ path, cwd }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    setState({ status: "loading" });

    (async () => {
      const bytes = await readBinaryFile(path);
      const size = bytes.byteLength;
      if (cancelled) return;
      task = await openPdf(bytes);
      if (cancelled) {
        void task.destroy();
        return;
      }
      const doc = await task.promise;
      const pages = await Promise.all(
        Array.from({ length: doc.numPages }, async (_, index) => {
          const page = await doc.getPage(index + 1);
          const { width, height } = page.getViewport({ scale: 1 });
          return { width, height };
        }),
      );
      if (!cancelled) setState({ status: "ready", doc, pages, size });
    })().catch((cause: unknown) => {
      if (cancelled) return;
      setState({
        status: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });

    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [path, reloadKey]);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    let timer = 0;
    const stop = watchFile(path, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 50);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [path, reload]);

  if (state.status === "loading") {
    return (
      <div className="grid h-full place-items-center text-[12px] text-content/45">
        Opening {basename(path)}…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md text-center">
          <AlertCircle className="mx-auto mb-3 size-5 text-red-400" />
          <p className="text-[13px] text-content">
            Couldn’t open {basename(path)}
          </p>
          <p className="mt-1 text-[12px] leading-5 text-content/50">
            {state.message}
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-content/35">
            {displayPath(path, cwd)}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <FooterButton onClick={reload}>
              <RotateCcw className="size-3" strokeWidth={1.75} />
              Retry
            </FooterButton>
            {path.startsWith(REMOTE_PATH_PREFIX) ? null : (
              <FooterButton
                onClick={() =>
                  void openPathWithDefaultApp(path).catch(() => {})
                }
              >
                Open externally
              </FooterButton>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <PdfPages
      path={path}
      doc={state.doc}
      pages={state.pages}
      size={state.size}
    />
  );
}

function PdfPages({
  path,
  doc,
  pages,
  size,
}: {
  path: string;
  doc: PDFDocumentProxy;
  pages: PageSize[];
  size: number;
}) {
  // Zoom is relative to fitting the widest page to the pane width.
  const [zoom, setZoom] = useState(1);
  const [paneWidth, setPaneWidth] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pixelRatio = useDevicePixelRatio();

  const widest = Math.max(...pages.map((page) => page.width));
  const fitScale = paneWidth > 0 ? (paneWidth - PADDING * 2) / widest : 0;
  const scale = fitScale * zoom;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(([entry]) =>
      setPaneWidth(entry.contentRect.width),
    );
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Keep the reading position when the zoom changes.
  const changeZoom = useCallback((next: number) => {
    const scroller = scrollerRef.current;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (scroller && clamped !== zoomRef.current) {
      const ratio = clamped / zoomRef.current;
      const top = scroller.scrollTop;
      const left = scroller.scrollLeft;
      requestAnimationFrame(() => {
        scroller.scrollTop = top * ratio;
        scroller.scrollLeft = left * ratio;
      });
    }
    setZoom(clamped);
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      changeZoom(zoomRef.current * Math.exp(-event.deltaY * unit * 0.01));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [changeZoom]);

  // While the pointer is over the preview, pinches and the zoom keys act on
  // the document instead of the app.
  useEffect(() => {
    if (!hovered) return;
    const release = claimTrackpadMagnify((delta) =>
      changeZoom(zoomRef.current * (1 + delta)),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      const action = resolveZoomKeybinding(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === "zoom-reset") changeZoom(1);
      else if (action === "zoom-in") changeZoom(zoomRef.current * ZOOM_STEP);
      else changeZoom(zoomRef.current / ZOOM_STEP);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      release();
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [hovered, changeZoom]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || scale <= 0) return;
    const middle = scroller.scrollTop + scroller.clientHeight / 2;
    let top = PADDING;
    for (let index = 0; index < pages.length; index += 1) {
      top += pages[index].height * scale + PAGE_GAP;
      if (top > middle) {
        setCurrentPage(index + 1);
        return;
      }
    }
    setCurrentPage(pages.length);
  }, [pages, scale]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-content/5"
        aria-label={`PDF preview: ${basename(path)}`}
      >
        {scale > 0 ? (
          <div
            className="mx-auto flex w-max min-w-full flex-col items-center"
            style={{ padding: PADDING, gap: PAGE_GAP }}
          >
            {pages.map((page, index) => (
              <PdfPage
                key={index}
                doc={doc}
                number={index + 1}
                width={page.width * scale}
                height={page.height * scale}
                scale={scale}
                pixelRatio={pixelRatio}
                root={scrollerRef}
              />
            ))}
          </div>
        ) : null}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-stroke px-3 text-[11px] text-content/50">
        <span className="tabular-nums">
          {currentPage} / {pages.length}
        </span>
        <span className="tabular-nums">{formatFileSize(size)}</span>
        <span>PDF</span>
        <span className="flex-1" />
        {path.startsWith(REMOTE_PATH_PREFIX) ? null : (
          <button
            type="button"
            onClick={() => void openPathWithDefaultApp(path).catch(() => {})}
            className="rounded px-1 hover:text-content"
          >
            Open externally
          </button>
        )}
        <ZoomButton
          label="Zoom out"
          onClick={() => changeZoom(zoom / ZOOM_STEP)}
        >
          <Minus className="size-3" strokeWidth={1.75} />
        </ZoomButton>
        <button
          type="button"
          title="Fit width"
          onClick={() => changeZoom(1)}
          className="w-11 rounded text-center tabular-nums hover:text-content"
        >
          {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
        </button>
        <ZoomButton
          label="Zoom in"
          onClick={() => changeZoom(zoom * ZOOM_STEP)}
        >
          <Plus className="size-3" strokeWidth={1.75} />
        </ZoomButton>
      </footer>
    </div>
  );
}

/** One page: a sized placeholder that draws itself once scrolled near. */
function PdfPage({
  doc,
  number,
  width,
  height,
  scale,
  pixelRatio,
  root,
}: {
  doc: PDFDocumentProxy;
  number: number;
  width: number;
  height: number;
  scale: number;
  pixelRatio: number;
  root: React.RefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: root.current, rootMargin: "800px 0px" },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !canvas) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    // Debounce so a pinch or drag-resize renders once it settles.
    const timer = window.setTimeout(async () => {
      try {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: scale * pixelRatio });
        const target = document.createElement("canvas");
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        task = page.render({ canvas: target, viewport });
        // Draw offscreen and copy over, so the old image stays up meanwhile.
        await task.promise;
        if (cancelled) return;
        canvas.width = target.width;
        canvas.height = target.height;
        canvas.getContext("2d")?.drawImage(target, 0, 0);
        setFailed(false);
      } catch {
        // Teardown cancels the render or destroys the document; only a
        // failure while this page is still wanted is worth showing.
        if (!cancelled) setFailed(true);
      }
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
  }, [doc, number, scale, pixelRatio, near]);

  return (
    <div
      ref={boxRef}
      className="relative shrink-0 bg-white shadow-sm ring-1 ring-black/10"
      style={{ width, height }}
    >
      <canvas
        ref={canvasRef}
        aria-label={`Page ${number}`}
        className="block h-full w-full"
      />
      {failed ? (
        <div className="absolute inset-0 grid place-items-center text-[12px] text-black/50">
          Couldn’t draw page {number}
        </div>
      ) : null}
    </div>
  );
}

/** The screen's pixel ratio, updated when the window moves to another display. */
function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const query = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const update = () => setRatio(window.devicePixelRatio || 1);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [ratio]);
  return ratio;
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-5 place-items-center rounded hover:bg-content/10 hover:text-content"
    >
      {children}
    </button>
  );
}

function FooterButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-md bg-content/10 px-2.5 text-[12px] text-content hover:bg-content/15"
    >
      {children}
    </button>
  );
}
