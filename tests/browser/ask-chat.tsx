import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePane } from "../../src/features/files/ui/FilePane";
import {
  ADD_TO_CHAT_EVENT,
  appendComposerInsert,
  type AddToChatRequest,
} from "../../src/features/sessions/model/quoteDraft";
import { applyAddToChatRequest } from "../../src/features/sessions/model/addChatToWorkspace";
import { buildUnifiedFile } from "../../src/features/source-control/model/unifiedDiff";
import { UnifiedDiffView } from "../../src/features/source-control/ui/UnifiedDiffView";
import type { Session } from "../../src/features/sessions/model/session";
import {
  newEditorPane,
  newFileTab,
  newPlanTab,
  newTerminalFile,
  type FilePaneTab,
} from "../../src/features/workspace/model/layout";
import "../../src/styles/index.css";

// The real file pane and viewers, with only native IPC replaced. The composer
// here takes the same event and the same insert a session pane's does.
const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "pdf";
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
localStorage.setItem("monocode.fileViewMode", "preview");

const TEXT_FILES: Record<string, string> = {
  "/repo/docs/guide.md":
    "# Guide\n\nAn opening line.\n\n## Install\n\nRun the installer once.\n\n## Use\n\nOpen a file and read it.\n",
  "/repo/data.csv":
    "Item,Q1,Q2,Q3\nRent,900,950,975\nFood,410,380,420\nTravel,120,640,75\nBooks,60,45,90\n",
  "/repo/analysis.ipynb": JSON.stringify({
    cells: [
      {
        cell_type: "markdown",
        source: ["# Sales\n", "A first look at the numbers."],
        metadata: {},
      },
      {
        cell_type: "code",
        execution_count: 1,
        source: ["total = 40 + 2\n", "print(total)"],
        outputs: [{ output_type: "stream", name: "stdout", text: ["42\n"] }],
        metadata: {},
      },
      { cell_type: "markdown", source: ["Closing remark."], metadata: {} },
    ],
    metadata: { language_info: { name: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  }),
  "/repo/design.html":
    '<!doctype html><html><body style="font:16px sans-serif;margin:24px"><h1>Launch page</h1><p id="copy">Ship it on Friday.</p></body></html>',
  "/repo/design2.html":
    '<!doctype html><html><body style="font:16px sans-serif;margin:24px"><p id="copy">Second page text.</p></body></html>',
  "/repo/main.tex":
    "\\documentclass{article}\n\\begin{document}Page one\\end{document}\n",
};

const eventHandlers = new Map<string, (event: unknown) => void>();
const callbacks = new Map<number, (value: unknown) => void>();
let nextCallback = 1;

Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: (callback: (value: unknown) => void) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    convertFileSrc: (path: string) => path,
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      switch (command) {
        case "read_binary_file":
          return fetch(
            String(args.path).endsWith(".xlsx")
              ? "./fixtures/ask-chat.xlsx"
              : String(args.path).endsWith("rotated.pdf")
                ? "./fixtures/ask-chat-rotated.pdf"
                : "./fixtures/preview.pdf",
          ).then((response) => response.arrayBuffer());
        case "read_text_file":
          return TEXT_FILES[String(args.path)] ?? "";
        case "stat_files":
          return [];
        case "git_diff_files":
          return { files: [] };
        case "fork_html_preview_create": {
          const blob = new Blob([String(args.source)], { type: "text/html" });
          return {
            id: `page-${nextCallback++}`,
            urlPath: URL.createObjectURL(blob),
            localAssets: false,
          };
        }
        case "fork_office_convert":
          return {
            status: "ok",
            pdf: "/cache/converted.pdf",
            cached: true,
            millis: 1,
          };
        case "fork_latex_compile":
          return {
            status: "ok",
            pdf: "/repo/out/main.pdf",
            engine: "pdflatex",
            millis: 1,
            errors: [],
            notes: [],
            warnings: 0,
            root: "/repo/main.tex",
          };
        case "plugin:event|listen": {
          const handler = callbacks.get(Number(args.handler));
          if (handler) eventHandlers.set(String(args.event), handler);
          return nextCallback++;
        }
        case "pty_spawn":
          window.setTimeout(() => {
            eventHandlers.get("pty-data")?.({
              payload: {
                id: args.id,
                data: btoa("cargo test failed at step nine\r\n"),
              },
            });
          }, 50);
          return null;
        case "pty_status":
          return { foreground: null };
        default:
          return null;
      }
    },
  },
});

const noop = () => {};

const planSession = {
  id: "s1",
  cwd: "/repo",
  harness: "claude",
  blocks: [
    {
      id: "b1",
      kind: "plan",
      text: "# Rollout\n\n## Steps\n\nFlip the flag at noon.\n",
      plan: { status: "ready" },
    },
  ],
} as unknown as Session;

function tabFor(name: string): FilePaneTab {
  switch (name) {
    case "pdf":
      return newFileTab("/repo/report.pdf", "/repo");
    case "rotated":
      return newFileTab("/repo/rotated.pdf", "/repo");
    case "html2":
      return newFileTab("/repo/design2.html", "/repo");
    case "office":
      return newFileTab("/repo/deck.pptx", "/repo");
    case "latex":
      return newFileTab("/repo/main.tex", "/repo");
    case "xlsx":
      return newFileTab("/repo/data.xlsx", "/repo");
    case "csv":
      return newFileTab("/repo/data.csv", "/repo");
    case "notebook":
      return newFileTab("/repo/analysis.ipynb", "/repo");
    case "markdown":
      return newFileTab("/repo/docs/guide.md", "/repo");
    case "html":
      return newFileTab("/repo/design.html", "/repo");
    case "terminal":
      return newTerminalFile("/repo");
    case "plan":
      return newPlanTab("s1", "b1", "Rollout", "/repo");
    default:
      throw new Error(`Unknown view: ${name}`);
  }
}

function Pane({ name }: { name: string }) {
  const [pane] = useState(() => newEditorPane(tabFor(name)));
  return (
    <FilePane
      pane={pane}
      focused
      visible
      dirtyFileIds={new Set()}
      fileErrorCounts={new Map()}
      sessions={[planSession]}
      onFocus={noop}
      onSelectFile={noop}
      onCloseFile={noop}
      onCloseOtherFiles={noop}
      onDirtyChange={noop}
      onErrorCountChange={noop}
      onReorderFiles={noop}
      onOpenFile={noop}
      onUpdatePlan={noop}
      onBuildPlan={noop}
    />
  );
}

const diff = buildUnifiedFile(
  "first line\nold wording here\nlast line\n",
  "first line\nnew wording here\nextra line here\nlast line\n",
);
const diffFiles = [
  {
    id: "src/app.ts",
    path: "src/app.ts",
    label: "src/app.ts",
    additions: diff.additions,
    deletions: diff.deletions,
    blocks: diff.blocks,
  },
];

function Fixture() {
  const [composer, setComposer] = useState("");
  const noSession = params.has("nosession");
  useEffect(() => {
    const onAdd = (event: Event) => {
      const { text, mode } = (event as CustomEvent<AddToChatRequest>).detail;
      if (noSession) {
        // No session pane is listening: App's fallback opens a chat.
        const result = applyAddToChatRequest({
          sessions: [],
          tabs: [],
          projectCwd: "/repo",
          text,
          mode,
        });
        setComposer(result?.sessions[0]?.composerSeed ?? "");
      } else {
        setComposer((draft) => appendComposerInsert(draft, text));
      }
    };
    window.addEventListener(ADD_TO_CHAT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_TO_CHAT_EVENT, onAdd);
  }, [noSession]);
  const panes = view.split(",");
  return (
    <div className="flex h-screen flex-col bg-background-base text-content">
      <div className="flex min-h-0 flex-1">
        {panes.map((name) => (
          <div key={name} className="flex min-h-0 min-w-0 flex-1">
            {name === "diff" ? (
              <UnifiedDiffView files={diffFiles} fill />
            ) : (
              <Pane name={name} />
            )}
          </div>
        ))}
      </div>
      <textarea
        aria-label="Composer"
        readOnly
        value={composer}
        className="h-32 shrink-0 resize-none bg-content/5 p-2 font-mono text-[12px] text-content outline-none"
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
