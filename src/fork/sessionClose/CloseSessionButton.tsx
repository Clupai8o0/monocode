import { useState } from "react";
import { CheckCheck } from "../../shared/ui/icons";

/**
 * Under a reply that ends "Safe to close: nothing left to do": archives the
 * session in one click. It stays restorable from Archived, so it does not ask.
 */
export function CloseSessionButton({
  onClose,
}: {
  onClose: () => Promise<boolean>;
}) {
  const [closing, setClosing] = useState(false);
  return (
    <div className="px-4 pt-1 pb-1">
      <button
        type="button"
        title="Archive this session; you can restore it from Archived"
        data-fork-safe-close=""
        disabled={closing}
        onClick={() => {
          setClosing(true);
          // On success the pane goes away; on failure App has told the person.
          void onClose().then(
            () => setClosing(false),
            () => setClosing(false),
          );
        }}
        className="flex select-none items-center gap-1.5 rounded-md bg-content/8 px-2 py-1 font-sans text-xs text-content/80 outline-none hover:bg-content/12 hover:text-content focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
      >
        <CheckCheck
          className="size-3.5 text-emerald-400"
          strokeWidth={2}
          aria-hidden="true"
        />
        Close session
      </button>
    </div>
  );
}
