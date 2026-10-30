import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { publishRunningWork } from "../../src/fork/backgroundAgents/runningAgents";
import { GamesButton } from "../../src/fork/games/GamesButton";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

// Fixed dice, and a chess position for the promotion test.
const globals = globalThis as Record<string, unknown>;
globals.__MONOCODE_TABLE_SEED__ = Number(params.get("seed") ?? 1234);
if (params.get("fen")) {
  globals.__MONOCODE_CHESS_FEN__ = params.get("fen");
}

// The spec drives agent activity through this, as App does through sessions.
globals.__setAgents = (working: number, waiting: number) => {
  const sessions = [
    ...Array.from({ length: working }, (_, i) => ({ id: `w${i}`, busy: true, blocks: [] })),
    ...Array.from({ length: waiting }, (_, i) => ({
      id: `q${i}`,
      busy: true,
      blocks: [],
      pendingQuestion: { id: "q" },
    })),
  ];
  publishRunningWork(sessions as never);
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex h-screen flex-col justify-end text-content">
      <label className="m-4 flex flex-col gap-1 text-[12px]">
        Composer
        <textarea aria-label="Composer" className="h-20 border border-content/20 bg-transparent p-2" />
      </label>
      <div className="flex-1" />
      <footer className="flex h-7 shrink-0 items-center gap-1.5 px-3 text-[11px] text-content/55">
        <span>Claude · 42%</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <GamesButton />
          <span className="px-1.5">Stacks · 2 up</span>
        </div>
      </footer>
    </div>
  </StrictMode>,
);
