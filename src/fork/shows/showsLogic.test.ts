// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  LOOPBACK_UNKNOWN_NOTE,
  PENDING_PER_MACHINE,
  PRIVATE_NOTE,
  RateLimit,
  backoffMs,
  capItems,
  idlePauseMs,
  isInside,
  isLoopback,
  isPrivateHost,
  withPending,
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

describe("review fixes", () => {
  const noAddress = { endpoint: "http://127.0.0.1:41000", ssh: null };
  it("counts every loopback form", () => {
    for (const host of [
      "localhost", "app.localhost", "127.0.0.1", "127.8.9.10", "0.0.0.0", "[::1]", "::", "[::]",
      "::ffff:127.0.0.1", "[::ffff:7f00:1]", "LOCALHOST.",
    ]) {
      expect(isLoopback(host), host).toBe(true);
    }
    for (const host of ["128.0.0.1", "10.0.0.1", "example.com", "::2", "mylocalhost"]) {
      expect(isLoopback(host), host).toBe(false);
    }
  });
  it("refuses loopback links when the address is unknown", () => {
    for (const url of ["http://localhost:3000/", "http://127.0.0.2/", "http://[::ffff:127.0.0.1]/", "http://x.localhost/"]) {
      expect(rewriteLink(url, noAddress)).toEqual({ note: LOOPBACK_UNKNOWN_NOTE });
    }
  });
  it("opens private links unchanged with a note", () => {
    for (const host of ["10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.1.5", "169.254.1.1", "[fd00::1]", "[fe80::1]", "printer.local"]) {
      const url = `http://${host}/`;
      expect(rewriteLink(url, noAddress), host).toEqual({ url: new URL(url).href, note: PRIVATE_NOTE });
    }
    expect(isPrivateHost("172.32.0.1")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
  it("shows the real file name next to a title", () => {
    const toast = groupToasts([{ machineId: "m", label: "Box", item: item({ title: "Report", name: "r.docx" }) }]);
    expect(toastText(toast[0])).toBe("Box sent Report (r.docx)");
    const same = groupToasts([{ machineId: "m", label: "Box", item: item({ title: "r.md", name: "r.md" }) }]);
    expect(toastText(same[0])).toBe("Box sent r.md");
  });
  it("spots old hosts that say unsupported", () => {
    expect(isUnknownMethod(new Error("Unsupported host method: shows.next"))).toBe(true);
    expect(isUnknownMethod("UNKNOWN METHOD")).toBe(true);
  });
  it("gives a root project no auto-open", () => {
    expect(isInside("/home/sam", "/")).toBe(false);
    expect(isInside("/home/sam/a", "/home/sam/")).toBe(true);
    expect(decideShow(item(), { ...base, activeProject: "remote://env1/" })).toBe("toast");
  });
  it("limits floods", () => {
    const many = Array.from({ length: 60 }, (_, i) => i);
    expect(capItems(many, 50)).toEqual(many.slice(10));
    expect(capItems([1, 2], 50)).toEqual([1, 2]);
    let pending: PendingShow[] = [{ machineId: "other", label: "O", item: item({ id: "o" }) }];
    for (let i = 0; i < 25; i += 1) {
      pending = withPending(pending, { machineId: "m", label: "M", item: item({ id: `i${i}` }) });
    }
    const mine = pending.filter((row) => row.machineId === "m");
    expect(mine).toHaveLength(PENDING_PER_MACHINE);
    expect(mine[0].item.id).toBe("i5");
    expect(pending.some((row) => row.machineId === "other")).toBe(true);
    expect(idlePauseMs(0, 200)).toBe(1000);
    expect(idlePauseMs(0, 5000)).toBe(0);
    expect(idlePauseMs(3, 200)).toBe(0);
  });
});
