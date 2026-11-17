import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { AgentTranscript } from "../../src/features/sessions/ui/AgentTranscript";
import { BackgroundAgentsBar } from "../../src/fork/backgroundAgents/BackgroundAgentsBar";
import { recordBoardTimings } from "../../src/fork/backgroundAgents/agentBoard";
import type { Block } from "../../src/features/sessions/model/session";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

const scene = params.get("scene") ?? "fold";
const startedAt = Date.now() - 8 * 60_000 - 37_000;

const foldBlocks: Block[] = [
  {
    id: "user",
    role: "user",
    text: "You've been quiet are you working?",
    startedAt,
    turnModel: {
      harness: "claude",
      id: "claude:opus-5-5",
      name: "Opus 5.5",
    },
  },
  {
    id: "think",
    role: "reasoning",
    streaming: true,
    text: [
      "The user is checking whether I'm still working after a long quiet stretch.",
      "I should keep digging through the auth module, then report what I find —",
      "not just sit on a timer that looks stuck.",
    ].join(" "),
  },
];

const agentBlocks: Block[] = [
  {
    id: "user",
    role: "user",
    text: "Review the auth module and run the tests.",
    startedAt: Date.now() - 4 * 60_000,
    turnModel: {
      harness: "claude",
      id: "claude:opus-5-5",
      name: "Opus 5.5",
    },
  },
  {
    id: "agent-1",
    role: "tool",
    text: "Search the auth module",
    tool: {
      kind: "agent",
      title: "Search the auth module",
      status: "in_progress",
      callId: "agent-1",
    },
    agentRun: {
      name: "Search the auth module",
      model: "claude-haiku-5-5",
      steps: [
        {
          id: "s1",
          kind: "tool",
          text: "Read src/features/auth/login.ts",
          status: "completed",
        },
        {
          id: "s2",
          kind: "tool",
          text: "Grep for sessionCookie across src/features/auth",
          status: "completed",
        },
        {
          id: "s3",
          kind: "tool",
          text: "Run npm test -- --run src/features/auth/",
          status: "in_progress",
        },
      ],
    },
  },
  {
    id: "cmd-1",
    role: "tool",
    text: "",
    tool: {
      kind: "execute",
      title: "npm run test:unit",
      status: "in_progress",
      background: true,
      command: "npm run test:unit -- --reporter=dot",
    },
  },
];

recordBoardTimings([{ busy: true, blocks: agentBlocks }], Date.now() - 4 * 60_000);

function FoldScene() {
  return (
    <div className="mx-auto flex h-screen max-w-[720px] flex-col justify-center px-6 text-content">
      <AgentTranscript
        blocks={foldBlocks}
        busy
        harness="claude"
        currentModelName="Opus 5.5"
        visible
      />
    </div>
  );
}

function QuietFoldScene() {
  // Same turn, but the fingerprint never changes — the quiet hint appears.
  const blocks: Block[] = [
    {
      ...foldBlocks[0],
      startedAt: Date.now() - 12 * 60_000,
    },
    {
      id: "shell",
      role: "tool",
      text: "cargo test",
      tool: { kind: "shell", status: "in_progress", title: "cargo test" },
    },
  ];
  return (
    <div className="mx-auto flex h-screen max-w-[720px] flex-col justify-center px-6 text-content">
      <AgentTranscript
        blocks={blocks}
        busy
        harness="claude"
        currentModelName="Opus 5.5"
        visible
      />
    </div>
  );
}

function AgentsScene() {
  return (
    <div className="flex h-screen flex-col items-center justify-end p-6 text-content">
      <div className="w-full max-w-[760px]">
        <BackgroundAgentsBar
          session={{
            busy: true,
            blocks: agentBlocks,
            backgroundJobs: [
              {
                id: "job-dev",
                title: "Dev server",
                command: "npm run dev -- --port 1420",
                startedAt: Date.now() - 3 * 60_000,
              },
            ],
          }}
          cwd="/repo"
          onStopJob={async () => undefined}
        />
        <div className="rounded-xl bg-content/[0.06] px-3 py-3 text-[13px] text-content/40">
          Reply to Claude…
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    {scene === "agents" ? (
      <AgentsScene />
    ) : scene === "quiet" ? (
      <QuietFoldScene />
    ) : (
      <FoldScene />
    )}
  </StrictMode>,
);
