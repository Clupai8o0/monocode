import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionSummary } from "../../src/features/sessions/data/sessionStore";
import type { Block, Session } from "../../src/features/sessions/model/session";
import { ProjectHomePage } from "../../src/fork/projectHome/ProjectHomePage";
import {
  openAllProjects,
  openProjectHome,
  setHomeLauncher,
  useHomePage,
} from "../../src/fork/projectHome/homeStore";
import "../../src/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

// Made-up projects and notes; nothing here is real.
const files: Record<string, string> = {
  "/p/yap/docs/plan.md": `# Yap: plan

| Phase | What | Done when | Status |
|---|---|---|---|
| 0 Mockups | Clickable looks | ✓ Sam picks a look | Done (Sam, 2 Nov) |
| 1 Daily writer | New note on every open, saved as you type | ✓ Works offline; ✓ Reopens attached files; Nothing lost after killing the app | Built (Phase 1 chat, 7 Nov) |
| 2 Search | Find any note fast | Search under 100 ms at 10,000 notes; Typo tolerant | In progress |
| 3 Sync | Two devices stay the same | Both devices match after a day offline | |
| 4 Rewards | Closing moment | Each note grows a plant; Everything can be turned off | |
`,
  "/p/glow/docs/plan.md": `| Step | Done when |
|---|---|
| 0.1 Monorepo scaffold: pnpm + Turborepo | \`pnpm test\` passes |
| 0.2 Vercel + Neon | \`/api/health\` returns 200 |
`,
  "/p/yap/.claude/handoff.md": `# Search: ranking done, typo tolerance next

Ranking ships behind a flag. Next: typo tolerance with a trigram index, then the 10,000-note benchmark.
`,
};
const mtimes: Record<string, number> = {};
for (const path of Object.keys(files)) {
  mtimes[path] = NOW - 2 * HOUR;
}

Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: { path?: string; paths?: string[]; content?: string }) => {
      if (command === "stat_files") {
        return (args.paths ?? []).map((path) => ({ path, mtimeMs: mtimes[path] ?? null }));
      }
      if (command === "read_text_file") {
        const text = args.path ? files[args.path] : undefined;
        if (text === undefined) {
          throw new Error("missing");
        }
        return text;
      }
      if (command === "write_text_file" && args.path) {
        files[args.path] = args.content ?? "";
        mtimes[args.path] = Date.now();
        return null;
      }
      return null;
    },
    transformCallback: () => 0,
  },
});

function block(role: Block["role"], extra: Partial<Block> = {}): Block {
  return { id: Math.random().toString(36).slice(2), role, text: "", ...extra } as Block;
}

function session(id: string, cwd: string, title: string, blocks: Block[], extra: Partial<Session> = {}): Session {
  return {
    id,
    cwd,
    harness: "claude",
    model: "opus",
    modelSettings: {},
    runtimeMode: "default",
    title,
    blocks,
    ...extra,
  } as Session;
}

const sessions: Session[] = [
  session("s-search", "/p/yap", "Phase 2 search ranking", [
    block("user", { text: "Build phase 2", startedAt: NOW - 20 * MIN }),
    block("assistant", { text: "Ranking is in. Starting typo tolerance with a trigram index." }),
    block("tool", { text: "", tool: { name: "Edit", status: "running" } as never }),
  ], { busy: true }),
  session("s-writer", "/p/yap", "Daily writer polish", [
    block("user", { text: "Polish", startedAt: NOW - 30 * HOUR }),
    block("assistant", { text: "Kill test passes on iOS. Android needs a device run." }),
    block("tool", {
      checklist: { action: "set", items: [{ text: "Run the kill test on your Android phone", who: "Sam" }] },
      tool: { status: "done" } as never,
    } as never),
  ]),
  session("s-sync", "/p/yap", "Which sync backend?", [
    block("user", { text: "Pick a sync backend", startedAt: NOW - 50 * MIN }),
    block("assistant", { text: "Two options look good." }),
  ], {
    busy: true,
    pendingQuestion: { title: "CRDT or last-write-wins for sync?", questions: [{ prompt: "CRDT or last-write-wins?" }] } as never,
  }),
  session("s-glow", "/p/glow", "Neon branch setup", [
    block("user", { text: "Set up Neon", startedAt: NOW - 5 * MIN }),
  ], { busy: true }),
];

const summaries: SessionSummary[] = [
  ...sessions.map((one, i) => ({
    id: one.id,
    cwd: one.cwd,
    harness: one.harness,
    model: one.model,
    runtimeMode: one.runtimeMode,
    title: one.title,
    createdAt: NOW - 3 * HOUR,
    updatedAt: one.id === "s-writer" ? NOW - 30 * HOUR : NOW - (i + 1) * 10 * MIN,
  })),
  { id: "s-misc", cwd: "/p/yap", harness: "codex", model: "gpt", runtimeMode: "default", title: "Fix the CI cache", createdAt: NOW - 9 * HOUR, updatedAt: NOW - 8 * HOUR },
  { id: "s-icons", cwd: "/p/yap", harness: "grok", model: "grok", runtimeMode: "default", title: "App icon ideas", createdAt: NOW - 9 * HOUR, updatedAt: NOW - 7 * HOUR },
  { id: "s-new", cwd: "/p/new", harness: "claude", model: "opus", runtimeMode: "default", title: "Set up the repo", createdAt: NOW - 9 * HOUR, updatedAt: NOW - 6 * HOUR },
] as SessionSummary[];

const launched: string[] = [];
setHomeLauncher(async (launch) => {
  launched.push(`${launch.cwd} | ${launch.title} | ${launch.reveal ? "reveal" : "quiet"}`);
  document.body.dataset.launched = launched.join("\n");
  return `launch-${launched.length}`;
});

const view = params.get("view") ?? "home";
if (view === "all") {
  openAllProjects();
} else {
  openProjectHome(view === "noplan" ? "/p/new" : view === "glow" ? "/p/glow" : "/p/yap");
}

function Fixture() {
  const page = useHomePage();
  const [opened, setOpened] = useState("");
  if (!page) {
    return <div data-closed>closed {opened}</div>;
  }
  return (
    <div className="flex min-h-0 w-full flex-col text-content" data-opened={opened}>
      <ProjectHomePage
        page={page}
        tabbed
        besideRail
        compactRail={false}
        projects={["/p/yap", "/p/glow", "/p/new"]}
        sessions={sessions}
        summaries={summaries}
        unseenIds={new Set()}
        onClose={() => {}}
        onOpenChat={(id) => setOpened(`chat:${id}`)}
        onOpenProjectHome={(cwd) => openProjectHome(cwd)}
        onOpenAllProjects={openAllProjects}
        onOpenFile={(path) => setOpened(`file:${path}`)}
        onNewChat={(cwd) => setOpened(`new:${cwd}`)}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
