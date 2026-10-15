import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "../../shared/ui/icons";
import { fitScale, formatSize, svgSize, type SvgSize } from "./svgModel";

const PADDING = 24;
const MIN_SCALE = 0.05;
const MAX_SCALE = 64;
const ZOOM_STEP = 1.25;

type Background = "checker" | "light" | "dark";
const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: "checker", label: "Checker" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
const BACKGROUND_KEY = "fork.svgPreview.background";

const BACKGROUND_STYLE: Record<Background, React.CSSProperties> = {
  checker: {
    backgroundColor: "#ffffff",
    backgroundImage:
      "repeating-conic-gradient(#d4d4d8 0% 25%, transparent 0% 50%)",
    backgroundSize: "16px 16px",
  },
  light: { backgroundColor: "#ffffff" },
  dark: { backgroundColor: "#18181b" },
};

function loadBackground(): Background {
  try {
    const saved = localStorage.getItem(BACKGROUND_KEY);
    return saved === "light" || saved === "dark" ? saved : "checker";
  } catch {
    return "checker";
  }
}

function saveBackground(value: Background) {
  try {
    localStorage.setItem(BACKGROUND_KEY, value);
  } catch {
    // Remembering the choice is a convenience only.
  }
}

/**
 * Fork feature: the SVG preview with zoom, a background switch and the
 * drawing's size. It still renders through an `<img>` from a blob URL, so the
 * SVG runs no script and fetches nothing, as upstream's preview did.
 */
export function SvgView({ source }: { source: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loadedSize, setLoadedSize] = useState<SvgSize | null>(null);
  const [broken, setBroken] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [background, setBackground] = useState<Background>(loadBackground);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next = URL.createObjectURL(
      new Blob([source], { type: "image/svg+xml" }),
    );
    setUrl(next);
    setBroken(false);
    return () => URL.revokeObjectURL(next);
  }, [source]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setBox({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const declared = useMemo(() => svgSize(source), [source]);
  const size = declared ?? loadedSize;
  const fit = size && box.width > 0 ? fitScale(size, box, PADDING) : null;
  const scale = zoom ?? fit;

  const changeZoom = (next: number) => {
    setZoom(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
        style={BACKGROUND_STYLE[background]}
      >
        {url ? (
          <div
            className="grid min-h-full min-w-full w-max place-items-center"
            style={{ padding: PADDING }}
          >
            {broken ? (
              <p className="rounded bg-black/60 px-2 py-1 text-[12px] text-white">
                This SVG has an error and can’t be drawn.
              </p>
            ) : (
              <img
                src={url}
                alt=""
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                    setLoadedSize({
                      width: image.naturalWidth,
                      height: image.naturalHeight,
                    });
                  }
                }}
                onError={() => setBroken(true)}
                className="max-w-none"
                style={
                  size && scale
                    ? {
                        width: size.width * scale,
                        height: size.height * scale,
                      }
                    : undefined
                }
              />
            )}
          </div>
        ) : null}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-stroke px-3 text-[11px] text-content/50">
        <span className="tabular-nums">
          {size ? `${formatSize(size)} px` : "No size set"}
        </span>
        <span>SVG</span>
        <span className="flex-1" />
        <div role="radiogroup" aria-label="Background" className="flex gap-0.5">
          {BACKGROUNDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={background === entry.id}
              onClick={() => {
                setBackground(entry.id);
                saveBackground(entry.id);
              }}
              className={`rounded px-1.5 ${
                background === entry.id
                  ? "bg-content/10 text-content"
                  : "hover:text-content"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!scale}
          onClick={() => scale && changeZoom(scale / ZOOM_STEP)}
          className="grid size-5 place-items-center rounded hover:bg-content/10 hover:text-content"
        >
          <Minus className="size-3" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title={zoom === null ? "Actual size" : "Fit to pane"}
          onClick={() => setZoom(zoom === null ? 1 : null)}
          className="w-11 rounded text-center tabular-nums hover:text-content"
        >
          {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={!scale}
          onClick={() => scale && changeZoom(scale * ZOOM_STEP)}
          className="grid size-5 place-items-center rounded hover:bg-content/10 hover:text-content"
        >
          <Plus className="size-3" strokeWidth={1.75} />
        </button>
      </footer>
    </div>
  );
}
