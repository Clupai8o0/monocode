import { describe, expect, it } from "vitest";
import {
  archivedGroupSessions,
  autoArchiveCandidates,
  mainListSessions,
} from "./archivedSessions";

const rows = [
  { id: "live", harness: "claude" },
  { id: "stored", harness: "claude", archived: true },
  { id: "stored-codex", harness: "codex", archived: true },
];
const ids = (list: readonly { id: string }[]) => list.map((row) => row.id);

describe("mainListSessions", () => {
  it("leaves archived sessions out until asked", () => {
    expect(ids(mainListSessions(rows, false, ""))).toEqual(["live"]);
    expect(ids(mainListSessions(rows, true, ""))).toEqual([
      "stored",
      "stored-codex",
    ]);
  });

  it("lets a search reach archived sessions", () => {
    expect(ids(mainListSessions(rows, false, " digest "))).toEqual(
      ids(rows),
    );
  });
});

describe("archivedGroupSessions", () => {
  const options = { showArchived: false, query: "", hiddenHarnesses: [] };

  it("lists every archived session", () => {
    expect(ids(archivedGroupSessions(rows, options))).toEqual([
      "stored",
      "stored-codex",
    ]);
  });

  it("respects hidden harnesses", () => {
    expect(
      ids(archivedGroupSessions(rows, { ...options, hiddenHarnesses: ["codex"] })),
    ).toEqual(["stored"]);
  });

  it("stands aside when the main list already shows them", () => {
    expect(archivedGroupSessions(rows, { ...options, showArchived: true })).toEqual([]);
    expect(archivedGroupSessions(rows, { ...options, query: "x" })).toEqual([]);
  });
});

describe("autoArchiveCandidates", () => {
  it("never picks a session open in a tab", () => {
    expect(ids(autoArchiveCandidates(rows, ["stored"]))).toEqual([
      "live",
      "stored-codex",
    ]);
  });
});
