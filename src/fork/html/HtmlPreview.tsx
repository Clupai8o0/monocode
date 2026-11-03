import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "../../shared/ui/icons";
import { displayPath } from "../../shared/lib/paths";
import { AskChatMenu } from "../askChat/AskChatRegion";
import {
  useFrameSelection,
  withSelectionBridge,
} from "../askChat/htmlSelectionBridge";
import { ASK_CHAT_ENABLED } from "../askChat/useAskChatSelection";
import { htmlPreviewUrl } from "./htmlModel";

export const HTML_PREVIEW_DELAY = 200;
type PreviewPage = { id: string; urlPath: string; localAssets: boolean };

// Must match the aggregate-budget error in src-tauri/src/fork_html.rs. A single
// source over the whole budget has its own message, and freeing can't help it.
const PREVIEW_MEMORY_FULL = "HTML preview memory is full.";

function removePreview(id: string): Promise<unknown> {
  return invoke("fork_html_preview_remove", { id }).catch(() => undefined);
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
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
  // Native calls still holding, or about to release, budget for this preview.
  const unsettled = useRef(new Set<Promise<unknown>>());
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { selection, dismissSelection } = useFrameSelection(
    frameRef,
    displayPath(path, cwd),
    active && page ? page.id : null,
  );
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
    const track = <T,>(call: Promise<T>) => {
      unsettled.current.add(call);
      const settle = () => unsettled.current.delete(call);
      call.then(settle, settle);
      return call;
    };
    const release = (id: string) => track(removePreview(id));
    const create = () =>
      track(
        invoke<PreviewPage>("fork_html_preview_create", {
          source: ASK_CHAT_ENABLED ? withSelectionBridge(source) : source,
          path,
          cwd,
        }).then((created) => {
          if (cancelled) {
            void release(created.id);
            return null;
          }
          return created;
        }),
      );
    // The old page's draft and the new one can't both fit once a source passes
    // half the budget, so a full budget gives up the old page and tries once
    // more. Only this run's predecessors can be held here: a newer run cancels
    // this one before it can free anything.
    const createWithinBudget = async () => {
      try {
        return await create();
      } catch (reason) {
        const canFree =
          retained.current.size > 0 || unsettled.current.size > 0;
        if (
          cancelled ||
          !canFree ||
          !errorMessage(reason).startsWith(PREVIEW_MEMORY_FULL)
        ) {
          throw reason;
        }
        for (const id of retained.current) {
          void release(id);
        }
        retained.current.clear();
        currentId.current = null;
        setPage(null);
        while (!cancelled && unsettled.current.size > 0) {
          await Promise.allSettled([...unsettled.current]);
        }
        return cancelled ? null : await create();
      }
    };
    const timer = setTimeout(() => {
      setError(null);
      void createWithinBudget().then(
        (created) => {
          if (!created) {
            return;
          }
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
            setError(errorMessage(reason));
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
          ref={frameRef}
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
      <AskChatMenu
        selection={selection}
        onDismiss={dismissSelection}
        overWhitePage
      />
    </div>
  );
}
