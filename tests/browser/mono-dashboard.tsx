import { createRoot } from "react-dom/client";
import type { Habit } from "../../src/features/monos/model/monoHabits";
import type { Session } from "../../src/features/sessions/model/session";
import { newSession } from "../../src/features/sessions/model/session";
import type { Contribution } from "../../src/fork/monoDashboard/dashboardModel";
import { MonoDashboard } from "../../src/fork/monoDashboard/MonoDashboard";
import "../../src/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const width = Number(params.get("width") ?? 420);
const empty = params.has("empty");
const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Made up: quiet weekends, a few busy spells, a streak running into today.
const contributions: Contribution[] = [];
if (!empty) {
  for (let back = 0; back < 170; back += 1) {
    const at = NOW - back * DAY;
    const weekend = [0, 6].includes(new Date(at).getDay());
    const swing = (back * 37) % 11;
    const count =
      back < 6
        ? 2 + (swing % 5)
        : weekend || swing < 4
          ? 0
          : Math.ceil(swing / 2) + (back < 50 ? 3 : 0);
    for (let index = 0; index < count; index += 1) {
      contributions.push({
        sessionId: "launch-1",
        kind: index % 5 === 4 ? "review" : "commit",
        reference: `${back}-${index}`,
        at: at - index * 60_000,
        additions: 40 + swing * 7,
        deletions: 6 + swing,
      });
    }
  }
  contributions.push({
    sessionId: "launch-1",
    kind: "merged",
    reference: "acme/app#12",
    at: NOW - HOUR,
    additions: 0,
    deletions: 0,
  });
}

const artifacts: Record<string, { createdAt: number }> = {
  d1: { createdAt: NOW - HOUR },
  d2: { createdAt: NOW - 2 * HOUR },
  old: { createdAt: NOW - 9 * DAY },
};

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: { id?: string }) => {
      if (command === "fork_mono_contributions") {
        return {
          contributions,
          sessions: empty
            ? []
            : [{ id: "launch-1", updatedAt: NOW - 3 * HOUR }],
        };
      }
      const artifact = args?.id ? artifacts[args.id] : undefined;
      return artifact ? { id: args.id, ...artifact } : null;
    },
  },
});

const habits: Habit[] = empty
  ? []
  : ([
      {
        id: "h1",
        name: "Morning digest",
        schedule: { kind: "daily", time: "09:00" },
        enabled: true,
        nextRunAt: NOW + 3 * HOUR,
        runs: [{ at: NOW - HOUR, durationMs: 60_000, outcome: "quiet" }],
      },
      {
        id: "h2",
        name: "Dependency check",
        schedule: { kind: "weekly", days: [2], time: "10:00" },
        enabled: true,
        nextRunAt: NOW + 2 * DAY,
      },
    ] as unknown as Habit[]);

const sessions: Session[] = empty
  ? []
  : [
      {
        ...newSession("codex", "/repo"),
        id: "launch-2",
        title: "Fix the login redirect",
        busy: true,
      },
    ];

createRoot(document.getElementById("root")!).render(
  <div data-shot="dashboard" className="p-3" style={{ width }}>
    <MonoDashboard
      monoId={`mono-${empty ? "empty" : "busy"}`}
      agent={{
        name: "Broski",
        mascot: "cat",
        color: params.get("color") ?? "#7aa2f7",
        projects: [],
      }}
      state={{ status: empty ? "idle" : "working" }}
      active
      sessionIds={["mono", "launch-1", "launch-2"]}
      launches={
        empty
          ? []
          : ["launch-1", "launch-2"].map((sessionId) => ({
              sessionId,
              cwd: "/repo",
              title: sessionId,
              harness: "codex",
              model: "gpt-6",
            }))
      }
      sessions={sessions}
      habits={habits}
      documents={
        empty
          ? []
          : [
              { id: "old", kind: "document", title: "Old notes" },
              {
                id: "d2",
                kind: "document",
                title: "Migration plan",
                summary: "What moves first and how to roll it back",
              },
              { id: "d1", kind: "document", title: "Release notes" },
            ]
      }
      onOpenHabit={() => {}}
      onOpenDocument={() => {}}
    />
  </div>,
);
