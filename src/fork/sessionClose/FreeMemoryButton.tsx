import { Sweep } from "../../shared/ui/icons";

/**
 * Closes every loaded session off screen, to free the memory their agent
 * CLIs and transcripts hold. They stay in the list and reopen on a click,
 * so it needs no confirmation.
 */
export function FreeMemoryButton({
  count,
  onClose,
}: {
  count: number;
  onClose: () => void;
}) {
  if (count === 0) {
    return null;
  }
  const label = `Close ${count} idle ${count === 1 ? "session" : "sessions"} to free memory`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-fork-free-memory=""
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClose}
      className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold tabular-nums text-content/50 hover:bg-content/10 hover:text-content"
    >
      <Sweep className="size-3" strokeWidth={1.75} aria-hidden="true" />
      <span>{count}</span>
    </button>
  );
}
