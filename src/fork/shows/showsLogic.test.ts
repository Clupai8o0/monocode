// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  RateLimit,
  backoffMs,
  base64Bytes,
  decideShow,
  groupToasts,
  isPassiveShow,
  isUnknownMethod,
  loadCursor,
  nextRound,
  rewriteLink,
  saveCursor,
  toastText,
  type PendingShow,
} from "./showsLogic";
import type { ShowItem } from "./showsModel";

const item = (patch: Partial<ShowItem> = {}): ShowItem => ({
  id: "abc",
  seq: 1,
  kind: "file",
  name: "report.md",
  size: 10,
  cwd: "/home/sam/app/sub",
  createdAt: 1_000_000,
  ...patch,
});

const machine = { environmentId: "env1" };
const base = {
  machine,
  activeProject: "remote://env1/home/sam/app",
  hostNow: 1_000_000 + 10_000,
  canOpen: true,
};

describe("decideShow", () => {
  it("opens a fresh passive file from the active project's folder", () => {
    expect(decideShow(item(), base)).toBe("open");
  });
  it("toasts when stale, elsewhere, off another machine, unsafe or rate limited", () => {
    expect(decideShow(item(), { ...base, hostNow: 1_000_000 + 3 * 60_000 })).toBe("toast");
    expect(decideShow(item({ cwd: "/home/sam/apple" }), base)).toBe("toast");
    expect(decideShow(item(), { ...base, activeProject: "remote://env2/home/sam/app" })).toBe("toast");
    expect(decideShow(item(), { ...base, activeProject: "/Users/sam/app" })).toBe("toast");
    expect(decideShow(item({ name: "paper.tex" }), base)).toBe("toast");
    expect(decideShow(item({ name: "deck.pptx" }), base)).toBe("toast");
    expect(decideShow(item(), { ...base, canOpen: false })).toBe("toast");
    expect(decideShow(item({ kind: "url", url: "https://x.dev/" }), base)).toBe("toast");
  });
  it("treats html, pdf, images and code as passive", () => {
    for (const name of ["a.html", "a.pdf", "a.PNG", "a.svg", "a.ts", "a.csv", "a.json"]) {
      expect(isPassiveShow({ kind: "file", name })).toBe(true);
    }
    expect(isPassiveShow({ kind: "file", name: "run.exe" })).toBe(false);
  });
});

describe("RateLimit", () => {
  it("allows five a minute", () => {
    const limit = new RateLimit();
    for (let i = 0; i < 5; i += 1) {
      expect(limit.take(i)).toBe(true);
    }
    expect(limit.take(10)).toBe(false);
    expect(limit.take(60_001)).toBe(true);
  });
});

describe("groupToasts", () => {
  const entry = (machineId: string, id: string): PendingShow => ({
    machineId,
    label: "Vivobook · Linux",
    item: item({ id, name: `${id}.pdf` }),
  });
  it("keeps up to three apart and folds more", () => {
    const three = groupToasts(["a", "b", "c"].map((id) => entry("m1", id)));
    expect(three.map((toast) => toast.kind)).toEqual(["one", "one", "one"]);
    expect(toastText(three[0])).toBe("Vivobook · Linux sent a.pdf");
    const five = groupToasts([...["a", "b", "c", "d", "e"].map((id) => entry("m1", id)), entry("m2", "z")]);
    expect(five).toHaveLength(2);
    expect(toastText(five[0])).toBe("Vivobook · Linux sent 5 items");
  });
});

describe("rewriteLink", () => {
  it("points localhost at the machine", () => {
    const direct = rewriteLink("http://localhost:3000/a?b=1", { endpoint: "http://100.64.0.2:7777", ssh: null });
    expect(direct?.url).toBe("http://100.64.0.2:3000/a?b=1");
    expect(direct?.note).toMatch(/all addresses/);
    const ssh = rewriteLink("http://127.0.0.1:8000/", {
      endpoint: "http://127.0.0.1:41000",
      ssh: { target: "sam@vivobook", remotePort: 7777 },
    });
    expect(ssh?.url).toBe("http://vivobook:8000/");
  });
  it("leaves other links and refuses non-http", () => {
    expect(rewriteLink("https://example.com/", { endpoint: "http://h:1" })).toEqual({ url: "https://example.com/" });
    expect(rewriteLink("file:///etc/passwd", { endpoint: "http://h:1" })).toBeUndefined();
    expect(rewriteLink("javascript:alert(1)", { endpoint: "http://h:1" })).toBeUndefined();
  });
});

describe("nextRound and cursor", () => {
  beforeEach(() => localStorage.clear());

  it("passes the cursor and keeps newer valid items", async () => {
    const asked: unknown[] = [];
    const round = await nextRound(async (params) => {
      asked.push(params);
      return { epoch: "e1", cursor: 7, now: 5, items: [item({ seq: 7, id: "b" }), item({ seq: 3 }), { bad: 1 }] };
    }, { epoch: "e1", cursor: 3 });
    expect(asked[0]).toEqual({ after: 3, epoch: "e1", waitMs: 25_000 });
    expect(round.items.map((entry) => entry.id)).toEqual(["b"]);
    expect(round.state).toEqual({ epoch: "e1", cursor: 7 });
    expect(round.now).toBe(5);
  });

  it("starts over on another epoch", async () => {
    const round = await nextRound(async () => ({ epoch: "e2", cursor: 2, now: 1, items: [item({ seq: 1 }), item({ seq: 2, id: "c" })] }), { epoch: "e1", cursor: 40 });
    expect(round.items).toHaveLength(2);
    expect(round.state).toEqual({ epoch: "e2", cursor: 2 });
  });

  it("rejects a bad answer", async () => {
    await expect(nextRound(async () => ({ items: [] }), { cursor: 0 })).rejects.toThrow();
  });

  it("stores cursors per machine", () => {
    expect(loadCursor("m1")).toEqual({ cursor: 0 });
    saveCursor("m1", { epoch: "e", cursor: 4 });
    saveCursor("m2", { epoch: "f", cursor: 1 });
    expect(loadCursor("m1")).toEqual({ epoch: "e", cursor: 4 });
  });
});

describe("helpers", () => {
  it("counts base64 bytes, backs off, spots old hosts", () => {
    expect(base64Bytes(btoa("hello"))).toBe(5);
    expect(base64Bytes(btoa("hi"))).toBe(2);
    expect(base64Bytes("")).toBe(0);
    expect([1, 2, 3, 6, 10].map(backoffMs)).toEqual([3000, 6000, 12000, 60000, 60000]);
    expect(isUnknownMethod(new Error("Unknown method: shows.next"))).toBe(true);
    expect(isUnknownMethod("timeout")).toBe(false);
  });
});
