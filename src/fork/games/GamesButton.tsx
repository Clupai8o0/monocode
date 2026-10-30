import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { GameController } from "../../shared/ui/icons";
import { GamesPanel } from "./GamesPanel";
import { gamesPanel } from "./gamesPanelStore";

/**
 * Fork: footer button for the games panel, to play something while agents
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

export function GamesButton() {
  return FORK_GAMES ? <Games /> : null;
}

function Games() {
  const open = useSyncExternalStore(gamesPanel.subscribe, gamesPanel.isOpen);
  return (
    <button
      type="button"
      data-fork-games=""
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 hover:bg-content/10 ${
        open ? "text-accent" : "text-content/70 hover:text-content"
      }`}
      aria-pressed={open}
      title="Games: something to play while agents work"
      // Keeps the board's focus when the click is what hides it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        mountPanel();
        gamesPanel.toggle();
      }}
    >
      <GameController className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className="hidden min-[1100px]:inline">Games</span>
    </button>
  );
}
