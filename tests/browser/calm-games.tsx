import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { GamesPanel } from "../../src/fork/games/GamesPanel";
import { gamesPanel } from "../../src/fork/games/gamesPanelStore";
import { publishTurns } from "../../src/fork/games/calm/turnBet";

// The games panel on its own, open on whichever game ?game= names.
const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const game = params.get("game");
if (game) {
  localStorage.setItem("monocode.fork.games.last", game);
}

// ?turns=1: two agent turns start a moment after load, for Turn Bet.
if (params.get("turns")) {
  publishTurns([]);
  publishTurns([
    { id: "s1", title: "Fix the login redirect", busy: true },
    { id: "s2", title: "Write release notes", busy: true },
  ]);
  (window as { endTurn?: (id: string) => void }).endTurn = (id) =>
    publishTurns([
      { id: "s1", title: "Fix the login redirect", busy: id !== "s1" },
      { id: "s2", title: "Write release notes", busy: id !== "s2" },
    ]);
}

createRoot(document.getElementById("root")!).render(<GamesPanel />);
gamesPanel.toggle();
