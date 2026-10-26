import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "../../shared/ui/icons";
import { htmlPreviewUrl } from "./htmlModel";

export const HTML_PREVIEW_DELAY = 200;
type PreviewPage = { id: string; urlPath: string; localAssets: boolean };

function removePreview(id: string) {
  void invoke("fork_html_preview_remove", { id }).catch(() => undefined);
}

/** Only native-served, opaque-origin pages run scripts. Never use app srcdoc. */
export function HtmlPreview({
  source,
  title,
  path,
  cwd,
  active: paneActive = true,
}: {
  source: string;
  title: string;
  path: string;
  cwd: string;
  active?: boolean;
}) {
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden,
  );
  const active = paneActive && documentVisible;
  const [page, setPage] = useState<(PreviewPage & { source: string }) | null>(
    null,
  );
  const retained = useRef(new Set<string>());
  const currentId = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const update = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!active) {
      setPage(null);
    }
    return () => {
      for (const id of retained.current) {
        removePreview(id);
      }
      retained.current.clear();
      currentId.current = null;
    };
  }, [active]);
  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setError(null);
      void invoke<PreviewPage>("fork_html_preview_create", {
        source,
        path,
        cwd,
      }).then(
        (created) => {
          if (cancelled) {
            removePreview(created.id);
            return;
          }
          retained.current.add(created.id);
          currentId.current = created.id;
          setPage({ ...created, source });
        },
        (reason: unknown) => {
          if (!cancelled) {
            for (const id of retained.current) {
              removePreview(id);
            }
            retained.current.clear();
            currentId.current = null;
            setPage(null);
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        },
      );
    }, HTML_PREVIEW_DELAY);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, path, cwd, active, reload]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-html-file-preview="">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-stroke px-2.5 text-[10px] text-content/45">
        <span
          className="min-w-0 flex-1 truncate"
          title="Project-relative images, styles, scripts and media are supported. External assets and network requests are blocked."
        >
          {page && !page.localAssets
            ? "Self-contained preview · local assets unavailable"
            : "HTML preview · external requests blocked"}
        </span>
        <button
          type="button"
          aria-label="Reload HTML preview"
          title="Reload preview"
          onClick={() => setReload((value) => value + 1)}
          className="grid size-5 shrink-0 place-items-center rounded hover:bg-content/10 hover:text-content focus-visible:outline focus-visible:outline-accent"
        >
          <RotateCcw className="size-3" />
        </button>
      </div>
      {error ? (
        <div
          role="alert"
          className="grid flex-1 place-content-center gap-2 p-5 text-center text-[12px] text-content/65"
        >
          <p>Couldn’t render HTML</p>
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setReload((value) => value + 1)}
            className="text-accent"
          >
            Try again
          </button>
        </div>
      ) : active && page ? (
        <iframe
          key={page.id}
          title={`HTML preview: ${title}`}
          src={htmlPreviewUrl(page.urlPath)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          aria-busy={page.source !== source}
          onLoad={() => {
            if (currentId.current !== page.id) {
              return;
            }
            // A previous page may still request media while its replacement
            // is loading. Release old tokens only once the new frame is ready.
            for (const id of retained.current) {
              if (id !== page.id) {
                removePreview(id);
                retained.current.delete(id);
              }
            }
          }}
        />
      ) : (
        <div
          role="status"
          className="grid flex-1 place-items-center text-[12px] text-content/45"
        >
          {active ? "Rendering HTML…" : "Preview paused"}
        </div>
      )}
    </div>
  );
}
