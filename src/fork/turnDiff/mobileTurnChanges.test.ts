// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../features/sessions/model/session";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
const projects = vi.hoisted(() => ({ paths: ["/visible"] }));
vi.mock("../../features/projects/model/recents", async (original) => ({
  ...(await original<typeof import("../../features/projects/model/recents")>()),
  loadRecents: () => projects.paths.map((path) => ({ path, openedAt: 1 })),
}));

import { mobileTurnChanges } from "../../features/mobile/model/mobileWorkspace";

const session = (over: Partial<Session> = {}) =>
  ({
    id: "s1",
    cwd: "/visible",
    blocks: [{ id: "u", role: "user", text: "", checkpointTurnId: "t1" }],
    ...over,
  }) as Session;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "fork_turn_changes") {
      return {
        files: [{ relative: "a.ts", status: "modified", additions: 1, deletions: 1 }],
        additions: 1,
        deletions: 1,
      };
    }
    if (command === "fork_turn_file_diff") {
      return {
        relative: "a.ts",
        status: "modified",
        original: "old\n",
        current: "new\n",
        binary: false,
        tooLarge: false,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe("mobileTurnChanges", () => {
  it("refuses a turn id the session never recorded", async () => {
    await expect(mobileTurnChanges("s1", "other", [session()])).rejects.toThrow(
      "no longer available",
    );
    expect(invoke).not.toHaveBeenCalledWith("fork_turn_changes", expect.anything());
  });

  it("refuses a session outside the phone's projects", async () => {
    await expect(
      mobileTurnChanges("s1", "t1", [session({ cwd: "/hidden" })]),
    ).rejects.toThrow("no longer available");
    expect(invoke).not.toHaveBeenCalledWith("fork_turn_changes", expect.anything());
  });

  it("sends each file with its diff lines", async () => {
    const result = await mobileTurnChanges("s1", "t1", [session()]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].lines.length).toBeGreaterThan(0);
  });
});
