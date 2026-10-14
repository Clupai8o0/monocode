import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FilePane } from "../../src/features/files/ui/FilePane";
import {
  newEditorPane,
  newFileTab,
} from "../../src/features/workspace/model/layout";
import "../../src/styles/index.css";

// Keep the real file pane and pdf.js, replacing only native IPC.
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string) => {
      if (command === "read_binary_file") {
        return fetch("./fixtures/preview.pdf").then((response) =>
          response.arrayBuffer(),
        );
      }
      if (command === "stat_files") return [];
      throw new Error(`Unexpected command: ${command}`);
    },
  },
});

const tab = newFileTab("/repo/report.pdf", "/repo");
const pane = newEditorPane(tab);
const noop = () => {};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FilePane
      pane={pane}
      focused
      visible
      dirtyFileIds={new Set()}
      fileErrorCounts={new Map()}
      sessions={[]}
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
  </StrictMode>,
);
