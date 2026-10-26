// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { newSession } from "../../features/sessions/model/session";
import { useSessionStatus, type SessionStatus } from "./StatusExtras";

const invoke = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@tauri-apps/api/core", async (load) => ({
  ...(await load<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  invoke.mockClear();
});

it("gives Codex artifact links without running Claude's script or leaking Claude metadata", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const session = newSession("codex", "/repo");
  session.blocks = [
    {
      id: "a",
      role: "assistant",
      text: "https://claude.ai/artifact/sidebar-review",
    },
  ];
  let status: SessionStatus | null = null;
  function Probe() {
    status = useSessionStatus(session, true);
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(status).toMatchObject({
      data: null,
      line: null,
      links: ["https://claude.ai/artifact/sidebar-review"],
      limits: { provider: "codex" },
    });
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
