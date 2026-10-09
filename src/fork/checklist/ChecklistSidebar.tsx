import { useMemo, useState } from "react";
import type { Block } from "../../features/sessions/model/session";
import { Check, ChevronRight, ListEnd } from "../../shared/ui/icons";
import { checklistFromBlocks } from "./checklist";

const COLLAPSED_KEY = "monocode.fork.checklistCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage blocked: the panel just won't remember being collapsed.
  }
}

/**
 * Fork feature: steps Claude has given the person, built from the session's
 * side-checklist tool calls. Shows only once the session has a checklist.
 */
export function ChecklistSidebar({ blocks }: { blocks: readonly Block[] }) {
  const list = useMemo(() => checklistFromBlocks(blocks), [blocks]);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  if (list.items.length === 0) return null;
  const done = list.items.filter((item) => item.done).length;
  const toggle = () => {
    setCollapsed(!collapsed);
    writeCollapsed(!collapsed);
  };
  if (collapsed) {
    return (
      <button
        type="button"
        data-fork-checklist="collapsed"
        aria-label={`Show checklist, ${done} of ${list.items.length} done`}
        title={list.title}
        onClick={toggle}
        className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-stroke py-3 text-content/50 hover:text-content/80"
      >
        <ListEnd className="size-4" strokeWidth={1.75} />
        <span className="font-mono text-[10px]">
          {done}/{list.items.length}
        </span>
      </button>
    );
  }
  return (
    <aside
      data-fork-checklist="open"
      aria-label={list.title}
      className="flex w-64 shrink-0 flex-col border-l border-stroke"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke px-3">
        <ListEnd
          className="size-4 shrink-0 text-content/45"
          strokeWidth={1.75}
        />
        <h2 className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-content/85">
          {list.title}
        </h2>
        <span className="shrink-0 rounded-full bg-content/7 px-2 py-0.5 font-mono text-[10px] text-content/50">
          {done}/{list.items.length}
        </span>
        <button
          type="button"
          aria-label="Hide checklist"
          onClick={toggle}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/7 hover:text-content/80"
        >
          <ChevronRight className="size-3.5" strokeWidth={2} />
        </button>
      </header>
      <ol className="scrollbar-none min-h-0 flex-1 overflow-y-auto py-1.5">
        {list.items.map((item, index) => (
          <li
            key={`${index}:${item.text}`}
            className="flex min-w-0 items-start gap-2.5 px-3 py-1.5"
          >
            <span className="mt-px w-4 shrink-0 text-right font-mono text-[10px] leading-4.5 text-content/35">
              {index + 1}
            </span>
            {item.done ? (
              <span
                aria-label="Done"
                className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-emerald-400/20 text-emerald-300"
              >
                <Check className="size-2.5" strokeWidth={2.5} />
              </span>
            ) : (
              <span
                aria-label="To do"
                className="mt-px size-4 shrink-0 rounded-full border border-content/25"
              />
            )}
            <div className="min-w-0 flex-1">
              <p
                className={`font-sans text-[12.5px] leading-4.5 ${
                  item.done
                    ? "text-content/40 line-through decoration-content/25"
                    : "text-content/80"
                }`}
              >
                {item.text}
              </p>
              {item.who || item.by ? (
                <p className="mt-0.5 font-sans text-[11px] leading-4 text-content/45">
                  {[item.who, item.by].filter(Boolean).join(" · ")}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
