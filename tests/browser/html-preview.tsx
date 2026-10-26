import { createRoot } from "react-dom/client";
import design from "../../fork/designs/projects-sidebar.html?raw";
import "../../src/styles/index.css";

// This fixture exercises the real file editor. Only native services are mocked;
// no filesystem, agent process, stored project or running app is touched.
const urls = new Map<string, string>();
const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
let source = design;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "read_text_file") return source;
      if (command === "write_text_file") { source = String(args.content); return; }
      if (command === "stat_files") return [];
      if (command === "fork_html_preview_create") {
        const id = crypto.randomUUID();
        const body = String(args.source);
        const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
        const html = body.replace(/<head\b[^>]*>/i, (tag) => `${tag}${head}`);
        const urlPath = `file-preview/${id}/index.html`;
        urls.set(urlPath, URL.createObjectURL(new Blob([html], { type: "text/html" })));
        return { id, urlPath, localAssets: false };
      }
      if (command === "fork_html_preview_remove") {
        const key = `file-preview/${args.id}/index.html`;
        const url = urls.get(key);
        if (url) URL.revokeObjectURL(url);
        urls.delete(key);
        return;
      }
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:event|unlisten") return;
      throw new Error(`Unexpected fixture command: ${command}`);
    },
    convertFileSrc: (path: string) => urls.get(path) ?? "about:blank",
    transformCallback: () => 1,
    unregisterCallback: () => undefined,
    metadata: { currentWindow: { label: "fixture" }, currentWebview: { label: "fixture" } },
  },
});
document.documentElement.classList.add("theme-dark");
document.body.style.margin = "0";
const { FileEditor } = await import("../../src/features/files/ui/FileEditor");
createRoot(document.getElementById("root")!).render(
  <main className="h-screen bg-background-base text-content">
    <FileEditor path="/fixture/projects-sidebar.html" cwd="/fixture" active onDirtyChange={() => undefined} />
  </main>,
);
