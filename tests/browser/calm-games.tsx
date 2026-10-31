import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { GamesPanel } from "../../src/fork/games/GamesPanel";
import { gamesPanel } from "../../src/fork/games/gamesPanelStore";

// The games panel on its own, open on whichever game ?game= names.
const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const game = params.get("game");
if (game) {
  localStorage.setItem("monocode.fork.games.last", game);
}

createRoot(document.getElementById("root")!).render(<GamesPanel />);
gamesPanel.toggle();
