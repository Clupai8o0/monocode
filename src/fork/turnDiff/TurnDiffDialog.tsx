import { useEffect, useMemo, useState } from "react";
import { notifyReviewChanged } from "../../features/sessions/model/checkpoint";
import { prepareUnifiedDiff } from "../../features/source-control/model/diffWorker";
import type { UnifiedFileDiff } from "../../features/source-control/model/unifiedDiff";
import {
  UnifiedDiffView,
  type UnifiedDiffFileModel,
} from "../../features/source-control/ui/UnifiedDiffView";
import { notifyGitChanged } from "../../platform/tauri/fs";
import { forEachConcurrent } from "../../shared/lib/concurrent";
import { Loader } from "../../shared/ui/icons";
import { Modal } from "../../shared/ui/Modal";
import {
  loadRestorePreview,
  loadTurnFileDiff,
  restoreSummary,
  restoreTurn,
  type RestorePreview,
  type TurnChanges,
} from "./turnDiff";

const PRESS =
  "transition-[background-color,color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

type Loaded = {
  unified: UnifiedFileDiff | null;
  binary: boolean;
  tooLarge: boolean;
  error?: string;
};

/** The confirm: every file it will touch, with anything risky pulled out. */
export function RestoreConfirm({
  preview,
  working,
  error,
  done,
  onConfirm,
  onCancel,
}: {
  preview: RestorePreview;
  working: boolean;
  error?: string;
  done: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const summary = restoreSummary(preview);
  return (
    <div
      data-fork-restore-confirm
      className="flex min-h-0 flex-col gap-3 rounded-xl bg-content/[0.05] px-3.5 py-3 font-sans"
    >
      {done ? (
        <p className="text-[13px] font-medium text-content">
          Restored. Your files are back as they were before this turn.
        </p>
      ) : preview.blocked ? (
        <p className="text-[13px] leading-relaxed text-content">{preview.blocked}</p>
      ) : summary.nothingToDo ? (
        <p className="text-[13px] text-content">
          Nothing to restore. These files already match how they were before this turn.
        </p>
      ) : (
        <>
          <div>
            <p className="text-[13px] font-medium text-content">
              Put {summary.total} {summary.total === 1 ? "file" : "files"} back as they
              were before this turn?
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-content/55 [text-wrap:pretty]">
              This includes changes from later turns in this session. The conversation stays.
              {preview.headMoved
                ? " Commits made since then stay too, and these files will show as changed."
                : ""}
            </p>
          </div>
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {preview.files.map((file) => (
              <li
                key={file.relative}
                className="flex min-w-0 items-baseline gap-2 text-[12px]"
              >
                <span
                  className={`shrink-0 ${file.action === "remove" ? "text-diff-del-fg" : "text-content/45"}`}
                >
                  {file.action === "remove" ? "Delete" : "Restore"}
                </span>
                <span
                  className="min-w-0 truncate font-mono text-[11px] text-content/80"
                  title={file.relative}
                >
                  {file.relative}
                </span>
                {file.editedSince ? (
                  <span className="shrink-0 text-amber-500">
                    changed since, that change would be replaced
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {error ? (
        <p role="alert" className="text-[12px] leading-relaxed text-diff-del-fg">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-1.5">
        {summary.canRestore && !done ? (
          <button
            type="button"
            disabled={working}
            onClick={onConfirm}
            className={`inline-flex h-7 items-center gap-1.5 rounded-lg bg-content px-2.5 text-[12px] font-medium text-background-base hover:bg-content/85 ${PRESS}`}
          >
            {working ? <Loader className="size-3.5 animate-spin" aria-hidden /> : null}
            Restore {summary.total} {summary.total === 1 ? "file" : "files"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onCancel}
          className={`inline-flex h-7 items-center rounded-lg px-2.5 text-[12px] text-content/65 hover:bg-content/8 hover:text-content ${PRESS}`}
        >
          {done ? "Done" : "Keep things as they are"}
        </button>
      </div>
    </div>
  );
}

/** Fork: the "This turn" view: only what one reply changed. */
export function TurnDiffDialog({
  sessionId,
  turnId,
  changes,
  busy,
  onClose,
}: {
  sessionId: string;
  turnId: string;
  changes: TurnChanges;
  busy: boolean;
  onClose: () => void;
}) {
  const [diffs, setDiffs] = useState<ReadonlyMap<string, Loaded>>(new Map());
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [working, setWorking] = useState(false);
  const [restored, setRestored] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void forEachConcurrent(
      changes.files,
      4,
      async (file) => {
        let loaded: Loaded;
        try {
          const diff = await loadTurnFileDiff(sessionId, turnId, file.relative);
          loaded = {
            binary: diff.binary,
            tooLarge: diff.tooLarge,
            unified:
              diff.binary || diff.tooLarge
                ? null
                : await prepareUnifiedDiff(
                    diff.original,
                    diff.current,
                    controller.signal,
                    1,
                  ),
          };
        } catch (caught) {
          loaded = { unified: null, binary: false, tooLarge: false, error: String(caught) };
        }
        if (controller.signal.aborted) return;
        setDiffs((current) => new Map(current).set(file.relative, loaded));
      },
      () => !controller.signal.aborted,
    );
    return () => controller.abort();
  }, [changes.files, sessionId, turnId]);

  const models = useMemo<UnifiedDiffFileModel[]>(
    () =>
      changes.files.map((file) => {
        const loaded = diffs.get(file.relative);
        return {
          id: file.relative,
          path: file.relative,
          label: file.relative,
          binary: loaded?.binary,
          tooLarge: loaded?.tooLarge,
          emptyMessage: !loaded ? "Loading…" : loaded.error,
          additions: file.additions,
          deletions: file.deletions,
          blocks: loaded?.unified?.blocks ?? [],
        };
      }),
    [changes.files, diffs],
  );

  const askRestore = () => {
    setError(undefined);
    setRestored(false);
    loadRestorePreview(sessionId, turnId)
      .then(setPreview)
      .catch((failure) => setError(String(failure)));
  };

  const confirmRestore = () => {
    setWorking(true);
    setError(undefined);
    restoreTurn(sessionId, turnId)
      .then(() => {
        setRestored(true);
        notifyGitChanged();
        notifyReviewChanged(sessionId);
      })
      .catch((failure) => setError(String(failure)))
      .finally(() => setWorking(false));
  };

  return (
    <Modal title="This turn's changes" onClose={onClose} size="lg">
      <div className="flex h-[70vh] min-h-0 flex-col gap-2.5 px-4 pb-4 font-sans">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[12px] text-content/55">
            Only what this reply changed, whatever happened before or after it.
          </p>
          {!preview ? (
            <button
              type="button"
              disabled={busy}
              title={busy ? "Wait for the agent to finish" : undefined}
              onClick={askRestore}
              className={`inline-flex h-7 shrink-0 items-center rounded-lg bg-content/10 px-2.5 text-[12px] font-medium text-content hover:bg-content/15 ${PRESS}`}
            >
              Restore to before this turn
            </button>
          ) : null}
        </div>
        {error && !preview ? (
          <p role="alert" className="text-[12px] text-diff-del-fg">
            {error}
          </p>
        ) : null}
        {preview ? (
          <RestoreConfirm
            preview={preview}
            working={working}
            error={error}
            done={restored}
            onConfirm={confirmRestore}
            onCancel={() => {
              setPreview(null);
              setError(undefined);
            }}
          />
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl">
          <UnifiedDiffView
            files={models}
            totals={{ additions: changes.additions, deletions: changes.deletions }}
          />
        </div>
      </div>
    </Modal>
  );
}
