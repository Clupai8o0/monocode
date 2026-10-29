import { describe, expect, it } from "vitest";
import {
  AUTO_PARK_AFTER_MS,
  autoParkStep,
  buildRows,
  formatBytes,
  parseReport,
  suggestParks,
  type MemoryReport,
  type SessionFacts,
} from "./memoryModel";

const GB = 1024 ** 3;
const MIN = 60_000;
const NOW = 10_000_000;

function facts(id: string, extra: Partial<SessionFacts> = {}): SessionFacts {
  return {
    id,
    title: id.toUpperCase(),
    busy: false,
    needsInput: false,
    foreground: false,
    // Idle sessions are always under 3 min: the stock timer parks them then.
    idleSince: NOW - 2 * MIN,
    ...extra,
  };
}

function report(
  pressure: MemoryReport["pressure"],
  sessions: [string, number][],
  availableBytes = 0.5 * GB,
): MemoryReport {
  return {
    pressure,
    totalBytes: 16 * GB,
    availableBytes,
    sessions: sessions.map(([sessionId, gb]) => ({
      sessionId,
      rssBytes: gb * GB,
      processCount: 1,
    })),
  };
}

const byId = (...list: SessionFacts[]) => new Map(list.map((f) => [f.id, f]));

describe("memory rows", () => {
  it("only idle, off-screen sessions with nothing waiting can be parked", () => {
    const rows = buildRows(
      report("warn", [
        ["idle", 1],
        ["busy", 2],
        ["asks", 1],
        ["screen", 1],
        ["starting", 1],
        ["helper", 1],
      ]),
      byId(
        facts("idle"),
        facts("busy", { busy: true }),
        facts("asks", { needsInput: true }),
        facts("screen", { foreground: true }),
        facts("starting", { idleSince: undefined }),
      ),
      NOW,
    );
    const state = Object.fromEntries(rows.map((r) => [r.sessionId, [r.state, r.parkable]]));
    expect(state).toEqual({
      idle: ["idle", true],
      busy: ["running", false],
      asks: ["waiting", false],
      screen: ["onScreen", false],
      starting: ["running", false],
      helper: ["helper", false],
    });
    expect(rows[0].sessionId).toBe("busy");
  });

  it("drops malformed report rows", () => {
    expect(
      parseReport({ pressure: "bogus", sessions: [{ sessionId: 3 }, { sessionId: "a", rssBytes: 5 }] }),
    ).toEqual({
      pressure: "normal",
      totalBytes: 0,
      availableBytes: 0,
      sessions: [{ sessionId: "a", rssBytes: 5, processCount: 0 }],
    });
    expect(parseReport(null)).toBeNull();
  });
});

describe("park suggestions", () => {
  it("suggests nothing while memory is fine", () => {
    const r = report("normal", [["a", 2]]);
    expect(suggestParks(buildRows(r, byId(facts("a")), NOW), r).rows).toEqual([]);
  });

  it("ranks by RAM times idle time and stops once enough is freed", () => {
    // warn wants 15% of 16 GB available: 2.4 GB, so 1.9 GB is needed.
    const r = report("warn", [
      ["mid-fresh", 1.5],
      ["mid-older", 1.5],
      ["small-older", 0.5],
      ["tiny-oldest", 0.1],
    ]);
    const rows = buildRows(
      r,
      byId(
        facts("mid-fresh", { idleSince: NOW - 1 * MIN }), // 1.5 GB x 2 = 3
        facts("mid-older", { idleSince: NOW - 2.5 * MIN }), // 1.5 x 3.5 = 5.25
        facts("small-older", { idleSince: NOW - 2.5 * MIN }), // 0.5 x 3.5 = 1.75
        facts("tiny-oldest", { idleSince: NOW - 2.9 * MIN }), // 0.1 x 3.9 = 0.39
      ),
      NOW,
    );
    const suggestion = suggestParks(rows, r);
    expect(suggestion.rows.map((row) => row.sessionId)).toEqual(["mid-older", "mid-fresh"]);
    expect(formatBytes(suggestion.freedBytes)).toBe("3.0 GB");
  });

  it("still ranks a big session that only just went idle over a tiny older one", () => {
    const r = report("warn", [["big", 2], ["tiny", 0.1]], 8 * GB);
    const rows = buildRows(
      r,
      byId(facts("big", { idleSince: NOW }), facts("tiny", { idleSince: NOW - 2.9 * MIN })),
      NOW,
    );
    expect(suggestParks(rows, r, 0).rows.map((row) => row.sessionId)).toEqual(["big"]);
  });

  it("parks at least one when the kernel says tight but the estimate does not", () => {
    const r = report("warn", [["a", 0.2], ["b", 0.1]], 8 * GB);
    const rows = buildRows(r, byId(facts("a"), facts("b")), NOW);
    expect(suggestParks(rows, r).rows.map((row) => row.sessionId)).toEqual(["a"]);
  });

  it("never suggests a session idle under a minute", () => {
    const r = report("critical", [["a", 2]]);
    const rows = buildRows(r, byId(facts("a", { idleSince: NOW - 30_000 })), NOW);
    expect(suggestParks(rows, r).rows).toEqual([]);
  });
});

describe("auto-park", () => {
  const r = report("critical", [
    ["idle", 2],
    ["busy", 3],
    ["asks", 3],
    ["screen", 3],
  ]);
  const rows = buildRows(
    r,
    byId(
      facts("idle", { idleSince: NOW - 1.5 * MIN }),
      facts("busy", { busy: true, idleSince: NOW - 1.5 * MIN }),
      facts("asks", { needsInput: true, idleSince: NOW - 1.5 * MIN }),
      facts("screen", { foreground: true, idleSince: NOW - 1.5 * MIN }),
    ),
    NOW,
  );
  const input = { enabled: true, report: r, rows, idleThresholdMs: 1 * MIN, now: NOW };

  it("does nothing while the setting is off, however long memory is tight", () => {
    const step = autoParkStep({ tightSince: NOW - 10 * MIN }, { ...input, enabled: false });
    expect(step).toEqual({ state: {}, park: [] });
  });

  it("waits for a minute of pressure, then parks only idle off-screen sessions", () => {
    const first = autoParkStep({}, input);
    expect(first.park).toEqual([]);
    const early = autoParkStep(first.state, { ...input, now: NOW + AUTO_PARK_AFTER_MS - 1 });
    expect(early.park).toEqual([]);
    const due = autoParkStep(first.state, { ...input, now: NOW + AUTO_PARK_AFTER_MS });
    expect(due.park.map((row) => row.sessionId)).toEqual(["idle"]);
    // And waits another minute before the next round.
    expect(due.state.tightSince).toBe(NOW + AUTO_PARK_AFTER_MS);
  });

  it("respects the idle threshold and resets when pressure clears", () => {
    const strict = autoParkStep(
      { tightSince: NOW - 2 * MIN },
      { ...input, idleThresholdMs: 2 * MIN },
    );
    expect(strict.park).toEqual([]);
    const calm = autoParkStep(
      { tightSince: NOW - 2 * MIN },
      { ...input, report: { ...r, pressure: "normal" } },
    );
    expect(calm).toEqual({ state: {}, park: [] });
  });

  it("with the threshold at 0, parks a session the moment its turn ends", () => {
    const fresh = report("critical", [["done", 2]]);
    const freshRows = buildRows(fresh, byId(facts("done", { idleSince: NOW })), NOW);
    const step = autoParkStep(
      { tightSince: NOW - 2 * MIN },
      { ...input, report: fresh, rows: freshRows, idleThresholdMs: 0 },
    );
    expect(step.park.map((row) => row.sessionId)).toEqual(["done"]);
    const oneMin = autoParkStep(
      { tightSince: NOW - 2 * MIN },
      { ...input, report: fresh, rows: freshRows, idleThresholdMs: 1 * MIN },
    );
    expect(oneMin.park).toEqual([]);
  });
});
