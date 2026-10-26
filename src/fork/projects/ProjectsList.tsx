import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveAgent } from "../../features/sessions/model/liveAgents";
import { sameProjectPath } from "../../features/projects/model/recents";
import {
  CurrentProjectIcon,
  useProjectLabel,
} from "../../features/projects/ui/CurrentProjectIcon";
import {
  Check,
  CircleAlert,
  MoreHorizontal,
  Plus,
} from "../../shared/ui/icons";
import { HandoffTag } from "../handoff/HandoffCard";
import { NotificationsButton } from "../notifications/NotificationsButton";
import {
  projectRows,
  projectStatusLabel,
  type ProjectRow,
} from "./projectsModel";

export function ProjectsList({
  paths,
  cwd,
  agents,
  busyPaths,
  onSelectProject,
  onOpenProject,
  onProjectContextMenu,
}: {
  paths: readonly string[];
  cwd: string;
  agents: readonly LiveAgent[];
  busyPaths?: Iterable<string>;
  onSelectProject: (path: string) => void;
  onOpenProject?: () => void;
  onProjectContextMenu: (
    path: string,
    x: number,
    y: number,
    trigger: HTMLElement,
  ) => void;
}) {
  const sorted = useMemo(
    () => projectRows(paths, agents, busyPaths),
    [paths, agents, busyPaths],
  );
  const [heldOrder, setHeldOrder] = useState<string[] | null>(null);
  const pointerInside = useRef(false);
  const focusInside = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const previousProject = useRef(cwd);
  const rows = useMemo(() => {
    if (!heldOrder) {
      return sorted;
    }
    const remaining = new Map(sorted.map((row) => [row.path, row]));
    const held = heldOrder.flatMap((path) => {
      const row = remaining.get(path);
      remaining.delete(path);
      return row ? [row] : [];
    });
    return [...held, ...remaining.values()];
  }, [sorted, heldOrder]);
  const hold = () =>
    setHeldOrder((current) => current ?? sorted.map((row) => row.path));
  const release = () => {
    if (!pointerInside.current && !focusInside.current) {
      setHeldOrder(null);
    }
  };
  useEffect(() => {
    // On launch, show the newest running projects at the top. Only an
    // explicit project switch should scroll its row into view.
    if (previousProject.current === cwd) {
      return;
    }
    previousProject.current = cwd;
    list.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [cwd]);

  return (
    <section
      data-fork-projects=""
      aria-label="Projects"
      className="flex max-h-[min(45%,19rem)] min-h-0 shrink-0 flex-col px-2 pb-2"
      onPointerEnter={() => {
        pointerInside.current = true;
        hold();
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        release();
      }}
      onFocusCapture={() => {
        focusInside.current = true;
        hold();
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        focusInside.current = false;
        release();
      }}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 px-2 text-[12px] font-medium text-content/50">
        <span className="min-w-0 flex-1">Projects</span>
        <NotificationsButton />
        {onOpenProject ? (
          <button
            type="button"
            aria-label="Open project"
            title="Open project"
            onClick={onOpenProject}
            className="-mr-1 grid size-6 place-items-center rounded-md outline-none transition-colors duration-150 hover:bg-content/10 hover:text-content focus-visible:ring-1 focus-visible:ring-accent active:bg-content/15"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      <ul
        ref={list}
        className="min-h-0 overflow-y-auto overscroll-contain"
        aria-label="Project list"
      >
        {rows.map((row) => (
          <ProjectListRow
            key={row.path}
            row={row}
            active={sameProjectPath(row.path, cwd)}
            onSelect={() => onSelectProject(row.path)}
            onContextMenu={onProjectContextMenu}
          />
        ))}
        {!rows.length ? (
          <li className="px-2 py-2 text-[12px] text-content/45">
            Open a project to get started.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function ProjectListRow({
  row,
  active,
  onSelect,
  onContextMenu,
}: {
  row: ProjectRow;
  active: boolean;
  onSelect: () => void;
  onContextMenu: (
    path: string,
    x: number,
    y: number,
    trigger: HTMLElement,
  ) => void;
}) {
  const label = useProjectLabel(row.path);
  const status = projectStatusLabel(row);
  const openMenu = (trigger: HTMLElement) => {
    const rect = trigger.getBoundingClientRect();
    onContextMenu(row.path, rect.left, rect.bottom, trigger);
  };
  return (
    <li
      data-project-path={row.path}
      className={`group flex h-8 items-center rounded-md ${active ? "bg-content/10" : "hover:bg-content/5"}`}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${label}${status ? `, ${status}` : ""}`}
        title={[label, status, row.activity, row.path]
          .filter(Boolean)
          .join("\n")}
        onClick={active ? undefined : onSelect}
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.focus();
          onContextMenu(
            row.path,
            event.clientX,
            event.clientY,
            event.currentTarget,
          );
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            openMenu(event.currentTarget);
          }
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent active:bg-content/10"
      >
        <CurrentProjectIcon
          cwd={row.path}
          busy={row.running}
          className="size-5"
          mascotClassName="size-3.5"
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[12px] leading-4 ${active ? "font-medium text-content" : "text-content/80"}`}
          >
            {label}
          </span>
          {row.activity ? (
            <span className="block truncate text-[10px] leading-3 text-content/45">
              {row.activity}
            </span>
          ) : null}
        </span>
        <HandoffTag path={row.path} />
        {status ? (
          <span
            aria-hidden
            className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums"
          >
            {row.running ? (
              <span
                title={row.working ? `${row.working} running` : "Running"}
                className="flex items-center gap-0.5 text-accent"
              >
                <span className="size-1.5 rounded-full bg-current" />
                {row.working || null}
              </span>
            ) : null}
            {row.waiting ? (
              <span
                title={`${row.waiting} need you`}
                className="flex items-center gap-0.5 text-amber-600 dark:text-amber-400"
              >
                <CircleAlert className="size-3" />
                {row.waiting}
              </span>
            ) : null}
            {row.done ? (
              <span
                title={`${row.done} done`}
                className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
              >
                <Check className="size-3" />
                {row.done}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Project settings for ${label}`}
        title={`Project settings for ${label}`}
        aria-haspopup="menu"
        onClick={(event) => openMenu(event.currentTarget)}
        className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-content/50 opacity-0 outline-none transition-[opacity,background-color] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-content/10 hover:text-content focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent active:bg-content/15 motion-reduce:transition-none"
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
      </button>
    </li>
  );
}
