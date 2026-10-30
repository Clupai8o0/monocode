import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { requestAddToChat } from "../../features/sessions/model/quoteDraft";
import {
  blockPicks,
  markPicksAdded,
  pendingPicks,
  pickKey,
  picksMessage,
  setTaskPick,
  subscribeTaskPicks,
  type BlockPicks,
} from "./picksStore";

/** Set around a finished or streaming reply; other Markdown keeps fixed boxes. */
export const TaskPicksContext = createContext<{
  blockId: string;
  streaming: boolean;
} | null>(null);

/** Which of the reply's Markdown blocks is rendering, as part of a box's key. */
export const TaskMarkdownBlock = createContext(0);

function useBlockPicks(blockId: string | undefined): BlockPicks | undefined {
  const read = useCallback(
    () => (blockId ? blockPicks(blockId) : undefined),
    [blockId],
  );
  return useSyncExternalStore(subscribeTaskPicks, read, read);
}

type MarkdownInputProps = ComponentProps<"input"> & {
  node?: unknown;
  "data-task-label"?: string;
  "data-task-occurrence"?: number;
};

export function MarkdownTaskInput({ node: _node, ...props }: MarkdownInputProps) {
  const reply = useContext(TaskPicksContext);
  const markdownBlock = useContext(TaskMarkdownBlock);
  const picks = useBlockPicks(reply?.blockId);
  const label = props["data-task-label"];
  if (!reply || !label) return <input {...props} />;
  const key = pickKey(
    markdownBlock,
    Number(props["data-task-occurrence"] ?? 0),
    label,
  );
  const pick = picks?.[key];
  return (
    <input
      type="checkbox"
      className="task-pick"
      aria-label={label}
      data-task-label={label}
      checked={pick ? pick !== "off" : !!props.checked}
      disabled={reply.streaming}
      onChange={(event) =>
        setTaskPick(reply.blockId, key, event.target.checked)
      }
    />
  );
}

/** A click on the item's text ticks it too, unless it opens something or selects. */
function tickFromRow(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as Element;
  if (target.closest("a, button, input, pre, code")) return;
  if (!window.getSelection()?.isCollapsed) return;
  const item = target.closest("li");
  const box = item?.querySelector<HTMLInputElement>("input.task-pick");
  if (box && !box.disabled && box.closest("li") === item) box.click();
}

/**
 * Makes the task boxes in one reply tickable, and offers to put the ticked ones
 * in the composer. Ticking alone sends nothing, so a box can also just be a
 * to-do the person checks off.
 */
export function TaskPicksReply({
  blockId,
  streaming,
  children,
}: {
  blockId: string;
  streaming: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ blockId, streaming }), [blockId, streaming]);
  const pending = pendingPicks(useBlockPicks(blockId));
  return (
    <TaskPicksContext.Provider value={value}>
      <div className="contents" onClick={tickFromRow}>
        {children}
      </div>
      {pending.length > 0 ? (
        <button
          type="button"
          data-task-picks-add
          className="mt-2 select-none rounded-md bg-content/8 px-2 py-1 font-sans text-xs text-content/80 hover:bg-content/12 hover:text-content"
          onClick={() => {
            requestAddToChat(picksMessage(pending), "plain");
            markPicksAdded(blockId, pending);
          }}
        >
          Add {pending.length} {pending.length === 1 ? "pick" : "picks"} to
          message
        </button>
      ) : null}
    </TaskPicksContext.Provider>
  );
}
