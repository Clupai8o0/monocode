import { useState } from "react";
import { createRoot } from "react-dom/client";
import { McpAccessView } from "../../src/fork/mcpAccess/McpAccessSection";
import type {
  CreatedMcpClient,
  McpClient,
  McpLogEntry,
} from "../../src/fork/mcpAccess/mcpAccess";
import "../../src/styles/index.css";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}
const NOW = 1_800_000_000_000;
const clients: McpClient[] = [
  { id: "1", name: "Codex on the Mac", level: "supervised", projects: ["/work/panoptic", "/work/monocode"], tokenHash: "", createdAt: NOW },
  { id: "2", name: "dsh bulk worker", level: "read", projects: ["/work/monocode"], tokenHash: "", createdAt: NOW },
];
const log: McpLogEntry[] = [
  { at: NOW - 40_000, client: "Codex on the Mac", action: "sessions.send", target: "4f2a91c0", ok: true, error: null },
  { at: NOW - 240_000, client: "dsh bulk worker", action: "sessions.send", target: "77be10aa", ok: false, error: "not allowed for its level" },
  { at: NOW - 900_000, client: "Codex on the Mac", action: "sessions.start", target: "/work/panoptic", ok: true, error: null },
  { at: NOW - 3_900_000, client: "dsh bulk worker", action: "sessions.read", target: "77be10aa", ok: true, error: null },
];
const created = {
  client: clients[0],
  token: "mcm_3f9a7c1e5b2d4f60a8c7e19d3b5f2a64",
  command: "/Applications/MonoCode.app/Contents/MacOS/monocode",
  endpointFile: "/Users/clupa/Library/Application Support/com.monocode.desktop/fork-mcp-endpoint",
} as CreatedMcpClient;

function Fixture() {
  const [shown, setShown] = useState<CreatedMcpClient | null>(
    params.has("created") ? created : null,
  );
  const empty = params.has("empty");
  return (
    <div className="@container/settings w-[720px] p-6">
      <McpAccessView
        projects={["/work/panoptic", "/work/monocode", "/work/dsec"]}
        clients={empty ? [] : clients}
        log={empty ? [] : log}
        created={shown}
        busy={false}
        now={NOW}
        onCreate={(name) => setShown({ ...created, client: { ...clients[0], name } })}
        onRevoke={() => {}}
        onDoneWithCreated={() => setShown(null)}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
