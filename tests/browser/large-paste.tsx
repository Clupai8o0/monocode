import { createRoot } from "react-dom/client";
import { Composer } from "../../src/features/sessions/ui/Composer";
import "../../src/styles/index.css";

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: () => 0,
    invoke: async (command: string) => {
      if (command === "plugin:event|listen") return 0;
      if (command === "plugin:event|unlisten") return;
      if (command === "write_attachment") return "/tmp/pasted-error-boom.txt";
      throw new Error(`Unexpected fixture command: ${command}`);
    },
  },
});
const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const PASTED = Array.from(
  { length: 900 },
  (_, line) => `Error: build failed at step ${line}: cannot resolve module './chunk-${line}.js'`,
).join("\n");

const noop = () => {};
function Fixture() {
  return (
    <div data-shot="composer" className="w-[720px] p-4 text-content">
      <Composer
        focused
        harness="codex"
        model=""
        runtimeMode="supervised"
        executionCwd="~"
        hideTopBar
        initialDraft={params.has("flood") ? PASTED : "Why is the build failing? "}
        onFocus={noop}
        onCwdChange={noop}
        onModelChange={noop}
        onRuntimeModeChange={noop}
        onSubmit={noop}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
