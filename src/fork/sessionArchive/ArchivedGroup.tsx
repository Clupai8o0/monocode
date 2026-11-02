import { useRef, useState, type ReactNode } from "react";
import { listWindowSize, LIST_PAGE_SIZE } from "../../shared/lib/listWindow";
import { ChevronRight } from "../../shared/ui/icons";

const OPEN_KEY = "monocode.fork.archivedOpen";

function readOpen(key: string): boolean {
  try {
    const map = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}");
    return map?.[key] === true;
  } catch {
    return false;
  }
}

function writeOpen(key: string, open: boolean) {
  try {
    const map = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") ?? {};
    if (open) {
      map[key] = true;
    } else {
      delete map[key];
    }
    localStorage.setItem(OPEN_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked: the group just starts collapsed next time.
  }
}

/**
 * Fork: under a project's sessions, the ones archived by hand or by cleanup.
 * Archiving tidies the main list and nothing else: they stay stored, one click
 * away. Opens by itself while the session on screen is one of them.
 */
export function ArchivedGroup<T extends { id: string }>({
  projectKey,
  sessions,
  activeId,
  renderRow,
}: {
  projectKey: string;
  sessions: readonly T[];
  activeId?: string | null;
  renderRow: (session: T) => ReactNode;
}) {
  const [openFor, setOpenFor] = useState<{
    key: string;
    open: boolean;
    activeId?: string | null;
  }>();
  const [limitFor, setLimitFor] = useState<{ key: string; limit: number }>();
  const root = useRef<HTMLDivElement>(null);
  if (sessions.length === 0) {
    return null;
  }
  const activeIndex = sessions.findIndex((session) => session.id === activeId);
  // A choice to collapse holds until another archived session comes on screen.
  const chosen =
    openFor?.key === projectKey &&
    (activeIndex < 0 || openFor.activeId === activeId);
  const open = chosen
    ? openFor.open
    : activeIndex >= 0 || readOpen(projectKey);
  const limit = limitFor?.key === projectKey ? limitFor.limit : LIST_PAGE_SIZE;
  const shown = listWindowSize(sessions.length, limit, activeIndex);
  const toggle = () => {
    writeOpen(projectKey, !open);
    setOpenFor({ key: projectKey, open: !open, activeId });
    if (!open) {
      // The group sits at the end of a scrolling list; show what just opened.
      requestAnimationFrame(() => root.current?.scrollIntoView?.({ block: "nearest" }));
    }
  };
  return (
    <div ref={root} data-fork-archived="" className="mt-3 px-1 pb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="group flex h-7 w-full items-center gap-1 rounded-md px-2 text-[12px] font-medium text-content/50 hover:text-content/80"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          strokeWidth={1.75}
        />
        <span>Archived</span>
        <span className="tabular-nums text-content/35">{sessions.length}</span>
      </button>
      {open ? (
        <ul className="flex flex-col gap-px">
          {sessions.slice(0, shown).map(renderRow)}
          {shown < sessions.length ? (
            <li className="list-none">
              <button
                type="button"
                data-fork-archived-more=""
                onClick={() =>
                  setLimitFor({ key: projectKey, limit: shown + LIST_PAGE_SIZE })
                }
                className="h-7 w-full rounded-md px-2 text-left text-[12px] text-content/50 hover:bg-content/5 hover:text-content/80"
              >
                Show more ({sessions.length - shown})
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
