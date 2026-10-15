import { describe, expect, it } from "vitest";
import {
  isForgotten,
  parseSnapshot,
  rowDetail,
  stopQuestion,
  upCount,
  type StackRow,
} from "./stacksModel";

// What `stacks.py list --json` printed on 15 Oct 2026, plus a lease.
const SAMPLE = {
  runtime: "orbstack",
  up: true,
  context: "orbstack",
  stacks: [
    { name: "ontrack-demo", state: "stopped", byHand: false, holders: [], idleMin: null },
    { name: "panoptic-phase-pos", state: "running", byHand: true, holders: [], idleMin: null },
    {
      name: "mymor-emulators",
      state: "running",
      byHand: false,
      holders: [{ name: "mymor-3a", why: "e2e tests", session: "abc" }],
      idleMin: null,
    },
  ],
  devices: [
    { name: "ios", kind: "ios", state: "booted", byHand: false, holders: [] },
    { name: "android", kind: "android", state: "off", byHand: false, holders: [] },
  ],
  loose: [{ name: "redis", status: "Up 2 hours", project: null }],
  looseError: null,
};

function row(over: Partial<StackRow>): StackRow {
  return {
    name: "s",
    kind: "stack",
    state: "running",
    byHand: false,
    holders: [],
    idleMin: null,
    ...over,
  };
}

describe("parseSnapshot", () => {
  it("reads stacks and devices into one list", () => {
    const snap = parseSnapshot(SAMPLE)!;
    expect(snap.runtime).toBe("orbstack");
    expect(snap.rows.map((r) => [r.name, r.kind, r.state])).toEqual([
      ["ontrack-demo", "stack", "stopped"],
      ["panoptic-phase-pos", "stack", "running"],
      ["mymor-emulators", "stack", "running"],
      ["ios", "ios", "running"],
      ["android", "android", "stopped"],
    ]);
    expect(snap.rows[2].holders).toEqual([
      { name: "mymor-3a", why: "e2e tests", session: "abc" },
    ]);
    expect(snap.loose).toEqual([{ name: "redis", status: "Up 2 hours", project: null }]);
    expect(upCount(snap)).toBe(3);
  });

  it("rejects other shapes and skips broken rows", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot("text")).toBeNull();
    expect(parseSnapshot({ runtime: "x" })).toBeNull();
    const snap = parseSnapshot({ stacks: [null, { state: "running" }, { name: "a", state: "odd" }] })!;
    expect(snap.rows).toEqual([row({ name: "a", state: "unknown" })]);
    expect(snap.up).toBe(false);
  });
});

describe("rows", () => {
  it("flags a stack started by hand that nobody holds", () => {
    const snap = parseSnapshot(SAMPLE)!;
    expect(snap.rows.filter(isForgotten).map((r) => r.name)).toEqual(["panoptic-phase-pos"]);
    expect(rowDetail(snap.rows[1])).toBe("started by hand, nobody using it");
    expect(isForgotten(row({ byHand: true, state: "stopped" }))).toBe(false);
  });

  it("asks before stopping only when someone holds it", () => {
    expect(stopQuestion(row({}))).toBeNull();
    const h = (name: string) => ({ name, why: "", session: null });
    expect(stopQuestion(row({ holders: [h("a")] }))).toBe("a is using this. Stop anyway?");
    expect(stopQuestion(row({ holders: [h("a"), h("a"), h("b")] }))).toBe(
      "a and b are using this. Stop anyway?",
    );
    expect(stopQuestion(row({ holders: [h("a"), h("b"), h("c"), h("d")] }))).toBe(
      "a, b and 2 more are using this. Stop anyway?",
    );
  });

  it("says who holds it, or that nobody does", () => {
    const snap = parseSnapshot(SAMPLE)!;
    expect(rowDetail(snap.rows[2])).toBe("mymor-3a (e2e tests)");
    expect(rowDetail(snap.rows[0])).toBe("stopped");
    expect(rowDetail(row({ idleMin: 12 }))).toBe("nobody using it, idle 12 min");
    expect(rowDetail(row({ state: "unknown" }))).toBe("state unknown (docker call failed)");
  });
});
