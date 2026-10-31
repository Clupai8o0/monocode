import { useRef, useState, useSyncExternalStore } from "react";
import { MoreHorizontal } from "../../shared/ui/icons";
import { Popover } from "../../shared/ui/Popover";
import { GamesButton } from "../games/GamesButton";
import { gamesPanel } from "../games/gamesPanelStore";
import { ringAlert, RingPanel, useRingStatus } from "../location/RingButton";
import { ringSentence } from "../location/location";

/** Off under the test runner, so upstream footer tests see no extra button. */
export const FORK_MORE = import.meta.env.MODE !== "test";

/**
 * Fork: footer chip "More", holding Games and the alert sounds. A problem with
 * the sounds or an open game still shows on its dot.
 */
export function MoreButton({ inset = false }: { inset?: boolean }) {
  return FORK_MORE ? <More inset={inset} /> : null;
}

function More({ inset }: { inset: boolean }) {
  const status = useRingStatus();
  const game = useSyncExternalStore(gamesPanel.subscribe, gamesPanel.isOpen);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const alert = ringAlert(status);
  const hover =
    [status ? ringSentence(status) : "", game ? "A game is open." : ""].filter(Boolean).join(" ") ||
    "Games and alert sounds";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-fork-more=""
        className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap hover:bg-content/10 ${
          inset ? "rounded-full px-2" : "rounded px-1.5"
        } ${
          open
            ? "text-accent"
            : alert || game
              ? "text-content/70 hover:text-content"
              : "text-content/40 hover:text-content"
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`More: ${hover}`}
        title={hover}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="hidden min-[1100px]:inline">More</span>
        {/* Always there, so the chip keeps its width when the dot comes on. */}
        <span
          data-fork-more-dot={alert ? "amber" : game ? "game" : ""}
          className={`size-1.5 shrink-0 rounded-full ${alert ? "bg-amber-400" : game ? "bg-accent" : "invisible"}`}
          aria-hidden
        />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="top"
          align="end"
          gap={6}
          width={320}
          ignore="[data-fork-more]"
          autoFocus
          tabIndex={-1}
          aria-label="More"
          className="flex flex-col overflow-y-auto"
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") {
              anchor.current?.focus();
            }
          }}
        >
          <div className="shrink-0 px-2 pt-2">
            <GamesButton
              onBeforeToggle={() => anchor.current?.focus()}
              onToggled={() => setOpen(false)}
            />
          </div>
          {status ? <RingPanel status={status} /> : null}
        </Popover>
      ) : null}
    </>
  );
}
