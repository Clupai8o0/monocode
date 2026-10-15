import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { AppWindow, Globe, Pencil, Trash2 } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { currentWorkspaceSlug } from "./workspaceWindow";
import {
  createWorkspace,
  deleteWorkspace,
  FORK_WORKSPACES,
  listWorkspaces,
  openWorkspace,
  openWorkspaceChrome,
  renameWorkspace,
  subscribeWorkspaceName,
  workspaceName,
  type WorkspaceRow,
} from "./workspaces";

/**
 * Fork: footer button naming this window's workspace. Opens the list of
 * workspaces: open or bring one forward, start a new one in its own window,
 * rename, forget a closed one, or open a Chrome window with its own profile.
 * File > New Workspace… and File > Workspaces… open the same list.
 */
export function WorkspacesButton() {
  return FORK_WORKSPACES ? <Workspaces /> : null;
}

function Workspaces() {
  const name = useSyncExternalStore(
    subscribeWorkspaceName,
    workspaceName,
    workspaceName,
  );
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const unlisten = [
      listen("fork_workspaces", () => {
        setCreating(false);
        setOpen(true);
      }),
      listen("fork_new_workspace", () => {
        setCreating(true);
        setOpen(true);
      }),
    ];
    return () => {
      void Promise.all(unlisten).then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-fork-workspaces=""
        className={`inline-flex h-5 min-w-0 max-w-[160px] shrink items-center gap-1.5 whitespace-nowrap rounded px-1.5 hover:bg-content/10 ${
          open
            ? "text-accent"
            : name
              ? "text-content/70 hover:text-content"
              : "text-content/40 hover:text-content"
        }`}
        aria-expanded={open}
        title={name ? `Workspace: ${name}` : "Workspaces: one window each"}
        onClick={() => {
          setCreating(false);
          setOpen(!open);
        }}
      >
        <AppWindow
          className="size-3.5 shrink-0"
          strokeWidth={1.75}
          aria-hidden
        />
        <span className="truncate">{name ?? "Workspaces"}</span>
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          gap={6}
          width={320}
          ignore="[data-fork-workspaces]"
          onDismiss={() => setOpen(false)}
        >
          <WorkspacesPanel
            startCreating={creating}
            onDone={() => setOpen(false)}
          />
        </Popover>
      ) : null}
    </>
  );
}

function WorkspacesPanel({
  startCreating,
  onDone,
}: {
  startCreating: boolean;
  onDone: () => void;
}) {
  const own = currentWorkspaceSlug();
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const newInput = useRef<HTMLInputElement>(null);

  const refresh = () =>
    listWorkspaces()
      .then((next) => {
        setRows(next);
      })
      .catch((e: unknown) => setError(String(e)));

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (startCreating) {
      newInput.current?.focus();
    }
  }, [startCreating]);

  const run = (work: Promise<unknown>, close = false) => {
    setError(null);
    void work
      .then(() => {
        if (close) {
          onDone();
        } else {
          void refresh();
        }
      })
      .catch((e: unknown) => setError(String(e)));
  };

  return (
    <div className="flex max-h-[420px] flex-col gap-1 p-2 text-[12px]">
      <div className="flex items-center gap-2 px-1 pb-1">
        <span className="font-semibold text-content">Workspaces</span>
        <span className="text-content/45">one window each</span>
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {rows === null ? (
          <span className="px-1.5 py-1 text-content/45">Loading…</span>
        ) : rows.length === 0 ? (
          <span className="px-1.5 py-1 text-content/45">
            None yet. Name one below to open it in its own window.
          </span>
        ) : (
          rows.map((row) => {
            const here = row.slug === own;
            const state = here ? "This window" : row.live ? "Open" : "Closed";
            if (renaming === row.slug) {
              return (
                <form
                  key={row.slug}
                  className="flex items-center gap-1 px-1 py-0.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setRenaming(null);
                    run(renameWorkspace(row.slug, renameDraft));
                  }}
                >
                  <input
                    autoFocus
                    value={renameDraft}
                    maxLength={40}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setRenaming(null);
                      }
                    }}
                    aria-label={`New name for ${row.name}`}
                    className="min-w-0 flex-1 rounded border border-content/15 bg-transparent px-1.5 py-0.5 text-content outline-none focus:border-accent"
                  />
                  <button
                    type="submit"
                    className="rounded px-1.5 py-0.5 text-content/70 hover:bg-content/10 hover:text-content"
                  >
                    Save
                  </button>
                </form>
              );
            }
            return (
              <div
                key={row.slug}
                data-fork-workspace-row=""
                className="group flex items-center gap-1 rounded-md hover:bg-content/5"
              >
                <button
                  type="button"
                  disabled={here}
                  title={here ? "You are here" : `Open ${row.name}`}
                  onClick={() => run(openWorkspace(row.slug), true)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left disabled:cursor-default"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${
                      here || row.live ? "bg-accent" : "bg-content/25"
                    }`}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate font-semibold text-content">
                    {row.name}
                  </span>
                  <span className="ml-auto shrink-0 text-content/45">
                    {state}
                  </span>
                </button>
                <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton
                    label={`Chrome for ${row.name} (its own profile)`}
                    onClick={() => run(openWorkspaceChrome(row.slug))}
                  >
                    <Globe
                      className="size-3.5"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  </IconButton>
                  <IconButton
                    label={`Rename ${row.name}`}
                    onClick={() => {
                      setRenameDraft(row.name);
                      setRenaming(row.slug);
                    }}
                  >
                    <Pencil
                      className="size-3.5"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  </IconButton>
                  {row.live ? null : armedDelete === row.slug ? (
                    <button
                      type="button"
                      onClick={() => {
                        setArmedDelete(null);
                        run(deleteWorkspace(row.slug));
                      }}
                      className="rounded px-1 text-[11px] font-semibold text-red-600 hover:bg-red-500/10 dark:text-red-400"
                    >
                      Forget?
                    </button>
                  ) : (
                    <IconButton
                      label={`Forget ${row.name} and its saved layout`}
                      onClick={() => setArmedDelete(row.slug)}
                    >
                      <Trash2
                        className="size-3.5"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    </IconButton>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
      <form
        className="flex items-center gap-1 border-t border-content/10 px-1 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) {
            return;
          }
          run(createWorkspace(draft), true);
        }}
      >
        <input
          ref={newInput}
          value={draft}
          maxLength={40}
          placeholder="New workspace name"
          aria-label="New workspace name"
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 rounded border border-content/15 bg-transparent px-1.5 py-0.5 text-content outline-none placeholder:text-content/35 focus:border-accent"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded px-1.5 py-0.5 text-content/70 hover:bg-content/10 hover:text-content disabled:opacity-40"
        >
          Open
        </button>
      </form>
      {error ? (
        <span role="alert" className="px-1 text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="rounded p-1 text-content/50 hover:bg-content/10 hover:text-content"
    >
      {children}
    </button>
  );
}
