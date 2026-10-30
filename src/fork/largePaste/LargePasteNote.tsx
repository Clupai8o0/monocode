import { formatPasteSize, type LargePaste } from "./largePaste";

/** Fork: says a big paste became a file, and offers it back as text. */
export function LargePasteNote({
  paste,
  onUseText,
}: {
  paste: LargePaste;
  onUseText: () => void;
}) {
  return (
    <div
      data-fork-large-paste
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 pt-2 font-sans text-[12px] text-content/55"
    >
      <span className="shrink-0">
        {formatPasteSize(paste.size)} pasted as a file
      </span>
      {paste.firstLine ? (
        <code
          className="min-w-0 flex-1 basis-40 truncate font-mono text-[11px] text-content/70"
          title={paste.firstLine}
        >
          {paste.firstLine}
        </code>
      ) : null}
      <button
        type="button"
        onClick={onUseText}
        className="shrink-0 rounded px-1 font-medium text-accent transition-colors duration-150 hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent"
      >
        Paste as text instead
      </button>
    </div>
  );
}
