import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { GameController } from "../../shared/ui/icons";
import { GamesPanel } from "./GamesPanel";
import { gamesPanel } from "./gamesPanelStore";

/**
 * Fork: the row in the footer's More chip that opens the games panel, to play something while agents
 * work. The panel is its own React root on the body: the footer goes away for
 * Settings and full-view Monos, and a game in progress shouldn't go with it.
 */
export const FORK_GAMES = import.meta.env.MODE !== "test";

let mounted = false;

function mountPanel() {
  if (mounted) {
    return;
  }
  mounted = true;
  const host = document.createElement("div");
  host.setAttribute("data-fork-games-root", "");
  document.body.appendChild(host);
  createRoot(host).render(<GamesPanel />);
}

type Props = {
  /** Before the panel opens or hides: it sends focus back to what has focus now. */
  onBeforeToggle?: () => void;
  onToggled?: () => void;
};

export function GamesButton(props: Props) {
  return FORK_GAMES ? <Games {...props} /> : null;
}

function Games({ onBeforeToggle, onToggled }: Props) {
  const open = useSyncExternalStore(gamesPanel.subscribe, gamesPanel.isOpen);
  return (
    <button
      type="button"
      data-fork-games=""
      className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md bg-content/[0.06] px-2 py-1.5 text-left text-[12px] font-medium hover:bg-content/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        open ? "text-accent" : "text-content"
      }`}
      aria-pressed={open}
      title="Games: something to play while agents work"
      // Keeps the board's focus when the click is what hides it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onBeforeToggle?.();
        mountPanel();
        gamesPanel.toggle();
        onToggled?.();
      }}
    >
      <GameController className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span>Games</span>
    </button>
  );
}
