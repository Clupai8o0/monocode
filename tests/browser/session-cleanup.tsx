import { useState } from "react";
import { createRoot } from "react-dom/client";
import { setCloseState, type CloseKind } from "../../src/fork/closeBadges/closeState";
import { SessionCleanup } from "../../src/fork/sessionCleanup/SessionCleanup";
import "../../src/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

const HOUR = 3_600_000;
const now = Date.now();

type Seed = [title: string, harness: string, hoursAgo: number, kind?: CloseKind];

const PROJECTS: Record<string, Seed[]> = {
  "/Users/me/projects/panoptic": [
    ["Fix the deploy queue on staging", "claude", 3, "safe"],
    ["Audit log export for the client", "codex", 20, "safe"],
    ["Rate limit review", "claude", 30, "handover"],
    ["Migrate the billing tables", "claude", 2, "unsafe"],
  ],
  "/Users/me/projects/monocode": [
    ["Cursor usage in the footer", "cursor", 5, "safe"],
    ["Games lag and load times", "claude", 9, "safe"],
    ["An old idea about the sidebar that never quite went anywhere but has a very long title", "grok", 24 * 12],
  ],
  "/Users/me/projects/glow-up": [
    ["Streak counter rounding", "claude", 26, "safe"],
    ["Handover for the onboarding copy", "codex", 50, "handover"],
  ],
  "/Users/me/projects/yap": [["First look at the repo", "claude", 24 * 30]],
};

const rowsOf = (cwd: string) =>
  (PROJECTS[cwd] ?? []).map(([title, harness, hoursAgo], index) => ({
    id: `${cwd}#${index}`,
    cwd,
    harness,
    model: "m",
    runtimeMode: "default",
    title,
    createdAt: now - hoursAgo * HOUR,
    updatedAt: now - hoursAgo * HOUR,
  }));

const archivedCalls: [string, boolean][] = [];
(window as unknown as Record<string, unknown>).__archiveCalls = archivedCalls;
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (command: string, args: { cwd?: string }) =>
    command === "session_list_by_project" ? rowsOf(args.cwd ?? "") : null,
};

for (const cwd of Object.keys(PROJECTS)) {
  for (const row of rowsOf(cwd)) {
    const kind = PROJECTS[cwd][Number(row.id.split("#")[1])][3];
    setCloseState(row.id, row.updatedAt, kind ? { kind, detail: "" } : null);
  }
}

const deletedCalls: string[] = [];
(window as unknown as { __deleteCalls: string[] }).__deleteCalls = deletedCalls;

function Fixture() {
  const [open, setOpen] = useState(true);
  return open ? (
    <SessionCleanup
      projectPaths={Object.keys(PROJECTS)}
      busySessionIds={new Set()}
      approvalSessionIds={new Set()}
      openSessionIds={["/Users/me/projects/monocode#1"]}
      onArchive={async (id, archived) => {
        archivedCalls.push([id, archived]);
        return true;
      }}
      onDelete={async (row) => {
        deletedCalls.push(row.id);
        return true;
      }}
      onClose={() => setOpen(false)}
    />
  ) : (
    <p data-closed="">Closed</p>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
