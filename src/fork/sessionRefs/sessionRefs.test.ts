import { describe, expect, it } from "vitest";
import type { ExternalSession } from "../externalSessions/externalSessionsModel";
import {
  buildIndex,
  refKey,
  refTarget,
  rehypeSessionRefs,
  splitMentions,
  type SessionRef,
} from "./sessionRefs";

const UUID = "5b891c51-fef3-4487-8a0c-467161608c8c";

function mentions(text: string): string[] {
  return splitMentions(text).flatMap((piece) =>
    typeof piece === "string" ? [] : [piece.mention],
  );
}

function ref(
  id: string,
  name: string | undefined,
  extra: Partial<ExternalSession> = {},
  machineId?: string,
): SessionRef {
  return {
    machineId,
    session: {
      id,
      name,
      projectId: "/p",
      source: "claude",
      cwd: "/p",
      state: "idle",
      hasTranscript: true,
      ...extra,
    },
  };
}

describe("splitMentions", () => {
  it("finds names and ids in a sentence", () => {
    expect(mentions(`Ask monocode-68, then ${UUID}. Also 5b891c51.`)).toEqual([
      "monocode-68",
      UUID,
      "5b891c51",
    ]);
  });

  it("keeps every character of the text", () => {
    const text = "Ask monocode-68, then t3-phases.";
    const joined = splitMentions(text)
      .map((piece) => (typeof piece === "string" ? piece : piece.mention))
      .join("");
    expect(joined).toBe(text);
  });

  it("leaves paths, file names and plain words alone", () => {
    expect(
      mentions("see src/fork/a-b/c-d and foo-bar.ts or --no-edit, hello 12345678x"),
    ).toEqual([]);
  });
});

describe("rehypeSessionRefs", () => {
  const text = (value: string) => ({ type: "text", value });
  const el = (tagName: string, ...children: object[]) => ({
    type: "element",
    tagName,
    children,
  });

  it("marks prose and a lone inline code name", () => {
    const tree = el(
      "p",
      text("ask monocode-68 now "),
      el("code", text("t3-phases")),
    );
    rehypeSessionRefs()(tree as never);
    expect(JSON.stringify(tree)).toContain('"dataSessionRef":"monocode-68"');
    expect(JSON.stringify(tree)).toContain('"dataSessionRef":"t3-phases"');
  });

  it("leaves links, code blocks and commands alone", () => {
    const tree = el(
      "div",
      el("a", text("monocode-68")),
      el("pre", el("code", text("monocode-68"))),
      el("p", el("code", text("peer send monocode-68"))),
    );
    rehypeSessionRefs()(tree as never);
    expect(JSON.stringify(tree)).not.toContain("dataSessionRef");
  });
});

describe("buildIndex", () => {
  it("finds a session by name, id and short id", () => {
    const entry = ref(UUID, "monocode-68");
    const index = buildIndex([entry]);
    expect(index.get("monocode-68")).toBe(entry);
    expect(index.get(UUID)).toBe(entry);
    expect(index.get("5b891c51")).toBe(entry);
  });

  it("prefers a live session, then this Mac, then the newest", () => {
    const ended = ref("a", "s-1", { state: "handed-over", startedAt: 9 });
    const live = ref("b", "s-1", { startedAt: 1 });
    expect(buildIndex([live, ended]).get("s-1")).toBe(live);
    const remote = ref("c", "s-2", { startedAt: 9 }, "vivobook");
    const mac = ref("d", "s-2", { startedAt: 1 });
    expect(buildIndex([mac, remote]).get("s-2")).toBe(mac);
    const older = ref("e", "s-3", { startedAt: 1 });
    const newer = ref("f", "s-3", { startedAt: 2 });
    expect(buildIndex([newer, older]).get("s-3")).toBe(newer);
  });

  it("does not index a handoff file by its path", () => {
    const index = buildIndex([ref("handoff:/p/h.md", undefined)]);
    expect(index.size).toBe(0);
  });
});

describe("refTarget", () => {
  it("reads a machine's session under its own project, or none if unfiled", () => {
    const filed = ref("a", "s", { projectId: "proj" }, "vivo");
    expect(refTarget(filed)).toEqual({
      kind: "remote",
      machineId: "vivo",
      projectId: "proj",
    });
    const unfiled = ref("b", "s", { projectId: "" }, "vivo");
    expect(refTarget(unfiled)).toMatchObject({ projectId: "" });
  });
});

describe("refKey", () => {
  it("changes when the session starts working", () => {
    expect(refKey(ref("a", "s", { state: "idle" }))).not.toBe(
      refKey(ref("a", "s", { state: "running" })),
    );
  });
});
