import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import type { AgentStep, Block } from "../../src/features/sessions/model/session";
import { BackgroundAgentsBar } from "../../src/fork/backgroundAgents/BackgroundAgentsBar";
import { recordBoardTimings } from "../../src/fork/backgroundAgents/agentBoard";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

const MIN = 60_000;
const start = Date.now() - 9 * MIN;
const steps = (prefix: string, texts: string[], failed: number[] = []): AgentStep[] =>
  texts.map((text, index) => ({
    id: `${prefix}${index}`,
    kind: "tool",
    text,
    toolKind: "read",
    status: failed.includes(index) ? "failed" : "completed",
  }));
function agent(id: string, name: string, model: string, status: string, trail: AgentStep[], detail?: string): Block {
  return {
    id,
    role: "tool",
    text: name,
    tool: { kind: "agent", title: name, status, callId: id, ...(detail ? { detail } : {}) },
    agentRun: { name, model, steps: [] },
  } as Block & { pendingSteps?: AgentStep[] };
}
const reads = (count: number) => Array.from({ length: count }, (_, i) => `Read src/features/sessions/ui/part${i}.tsx`);

// Each run's script: when it starts, a step every so often, when it ends.
const runs = [
  { block: agent("a1", "Correctness review", "claude-opus-5-5", "completed", [], "The diff is sound. One off-by-one in the pager, fixed."), at: 0, every: 25, trail: steps("a1-", reads(14)), end: 6 * MIN },
  { block: agent("a2", "Migration audit", "claude-sonnet-5-5", "failed", [], "Rate limited after 3 retries."), at: 0.5 * MIN, every: 40, trail: steps("a2-", reads(5), [4]), end: 4 * MIN },
  { block: agent("a3", "Search the auth module", "claude-haiku-5-5", "in_progress", []), at: 1 * MIN, every: 20, trail: steps("a3-", [...reads(20), "Run npm test -- --run src/features/auth/\n  --reporter=dot"]), end: null },
  { block: agent("a4", "Long build check", "claude-opus-5-5", "in_progress", []), at: 2 * MIN, every: 30, trail: steps("a4-", ["Read vite.config.ts", "Run cargo build --release"]), end: null },
  { block: agent("a5", "Write the changelog", "claude-sonnet-5-5", "in_progress", []), at: 8.8 * MIN, every: 0, trail: [], end: null },
];
const command = {
  id: "c1",
  role: "tool",
  text: "npm run dev -- --port 1420",
  tool: { kind: "execute", title: "npm run dev -- --port 1420", status: "in_progress", background: true },
} as Block;
const user = { id: "u1", role: "user", text: "Review this" } as Block;

function session(scene: string): { busy: boolean; blocks: Block[] } {
  if (scene === "sequential") {
    return { busy: true, blocks: [user, runs[0].block, runs[4].block] };
  }
  if (scene === "single") {
    return { busy: true, blocks: [user, runs[2].block] };
  }
  if (scene === "alldone") {
    return { busy: true, blocks: [user, runs[0].block, runs[1].block] };
  }
  return { busy: true, blocks: [user, ...runs.map((run) => run.block), command] };
}

const scene = params.get("scene") ?? "board";
const current = session(scene);
const inScene = runs.filter((run) => current.blocks.includes(run.block));

/** Replays the script through the real store, on the clock it would have seen. */
function replay(): void {
  const finalStatus = new Map(inScene.map((run) => [run.block.id, run.block.tool!.status!]));
  const moments = new Set<number>([9 * MIN]);
  for (const run of inScene) {
    moments.add(run.at);
    if (run.end !== null) {
      moments.add(run.end);
    }
    run.trail.forEach((_, index) => moments.add(run.at + (index + 1) * run.every * 1000));
  }
  const sorted = [...moments].filter((at) => at <= 9 * MIN).sort((a, b) => a - b);
  for (const at of sorted) {
    const blocks = current.blocks.filter((block) => {
      const run = inScene.find((candidate) => candidate.block === block);
      return !run || run.at <= at;
    });
    for (const run of inScene) {
      const shown = run.trail.filter((_, index) => run.at + (index + 1) * run.every * 1000 <= at);
      const ended = run.end !== null && run.end <= at;
      run.block.agentRun = { ...run.block.agentRun!, steps: ended ? run.trail : shown };
      run.block.tool = {
        ...run.block.tool!,
        status: ended ? finalStatus.get(run.block.id)! : "in_progress",
      };
    }
    recordBoardTimings([{ busy: true, blocks }], start + at);
  }
  for (const run of inScene) {
    run.block.tool = { ...run.block.tool!, status: finalStatus.get(run.block.id)! };
  }
}
replay();

// Live: a new step lands on the running agent, as App would publish it.
(window as unknown as Record<string, unknown>).__addStep = () => {
  const run = runs[2].block;
  run.agentRun = {
    ...run.agentRun!,
    steps: [...run.agentRun!.steps, { id: `new-${Date.now()}`, kind: "tool", text: "Read the newest step", status: "completed" }],
  };
  recordBoardTimings([current]);
};

function App() {
  const [other, setOther] = useState(false);
  const width = params.get("width");
  return (
    <div className="flex h-screen flex-col items-center justify-end p-4 text-content">
      <button type="button" data-switch-session onClick={() => setOther(!other)} className="mb-2 text-[12px]">
        Switch session
      </button>
      <div style={{ width: width ? `${width}px` : "760px", maxWidth: "100%" }}>
        <BackgroundAgentsBar key={other ? "other" : "main"} session={current} cwd="/repo" />
        <div className="rounded-xl bg-content/[0.06] px-3 py-3 text-[13px] text-content/40">Reply to Claude…</div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
