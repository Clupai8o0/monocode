import { describe, expect, it } from "vitest";
import {
  ago,
  holdersOf,
  parseClaims,
  relativeTo,
  tagLabel,
  tagTone,
  tagTooltip,
} from "./claimsModel";

const TOP = "/Users/me/projects/app";
const OTHER = "/Users/me/projects/app-wt";
const NOW = 1_792_074_000_000;
const sec = (minAgo: number) => (NOW - minAgo * 60_000) / 1000;

// The shape `claims.py list --json` prints.
const SAMPLE = {
  top: TOP,
  here: ".",
  claims: [
    {
      file: "src/auth/signin.ts",
      worktree: TOP,
      session: "s1",
      branch: "main",
      at: sec(4),
      name: "monocode-57",
    },
    {
      file: "src/auth/session.ts",
      worktree: TOP,
      session: "s1",
      branch: "main",
      at: sec(9),
      name: "monocode-57",
    },
    {
      file: "firestore.rules",
      worktree: TOP,
      session: "s2",
      branch: "main",
      at: sec(1),
      name: "codex",
    },
    {
      file: "src/auth/signin.ts",
      worktree: OTHER,
      session: "s3",
      branch: "wt",
      at: sec(0),
      name: "monocode-12",
    },
    { file: "", worktree: TOP, session: "s9", at: sec(1) },
    "junk",
  ],
  notes: [
    {
      text: "adding rate limit to sign-in",
      worktree: TOP,
      session: "s1",
      branch: "main",
      at: sec(4),
      noted_at: sec(20),
      name: "monocode-57",
    },
  ],
};

describe("parseClaims", () => {
  it("reads the script's JSON and drops broken rows", () => {
    const snap = parseClaims(SAMPLE)!;
    expect(snap.top).toBe(TOP);
    expect(snap.claims).toHaveLength(4);
    expect(snap.claims[0].at).toBe(NOW - 4 * 60_000);
    expect(snap.notes[0].notedAt).toBe(NOW - 20 * 60_000);
  });

  it("is null outside a repo or for odd shapes", () => {
    expect(parseClaims({ top: null, claims: [], notes: [] })).toBeNull();
    expect(parseClaims(null)).toBeNull();
    expect(parseClaims("x")).toBeNull();
  });
});

describe("relativeTo", () => {
  const snap = parseClaims({ ...SAMPLE, top: "/real/app", here: "pkg" })!;

  it("maps paths under the folder MonoCode asked for, even through a symlink", () => {
    expect(relativeTo(snap, "/link/app/pkg", "/link/app/pkg/a.ts")).toBe(
      "pkg/a.ts",
    );
    expect(relativeTo(snap, "/link/app/pkg/", "/link/app/pkg")).toBe("pkg");
    expect(relativeTo(snap, "/link/app/pkg", "/real/app/b.ts")).toBe("b.ts");
  });

  it("ignores paths outside, including name prefixes", () => {
    expect(relativeTo(snap, "/link/app/pkg", "/link/app/pkg2/a.ts")).toBeNull();
    expect(relativeTo(snap, "/link/app/pkg", "/elsewhere/a.ts")).toBeNull();
  });
});

describe("holdersOf", () => {
  const snap = parseClaims(SAMPLE)!;

  it("finds a file's holders, this worktree first, with the note", () => {
    const h = holdersOf(snap, TOP, `${TOP}/src/auth/signin.ts`, false);
    expect(h.map((x) => x.name)).toEqual(["monocode-57", "monocode-12"]);
    expect(h[0].otherTree).toBe(false);
    expect(h[0].note?.text).toBe("adding rate limit to sign-in");
    expect(h[1].otherTree).toBe(true);
    expect(h[1].note).toBeNull();
  });

  it("counts a session's files under a folder once", () => {
    const h = holdersOf(snap, TOP, `${TOP}/src`, true);
    const mine = h.find((x) => x.name === "monocode-57")!;
    expect(mine.files).toBe(2);
    expect(mine.at).toBe(NOW - 4 * 60_000);
  });

  it("covers the whole repo from the root folder", () => {
    const h = holdersOf(snap, TOP, TOP, true);
    expect(h.map((x) => x.name).sort()).toEqual([
      "codex",
      "monocode-12",
      "monocode-57",
    ]);
  });

  it("is empty for unclaimed files and similar names", () => {
    expect(holdersOf(snap, TOP, `${TOP}/src/auth/signin.tsx`, false)).toEqual(
      [],
    );
    expect(holdersOf(snap, TOP, `${TOP}/src/aut`, true)).toEqual([]);
  });
});

describe("tag text", () => {
  const snap = parseClaims(SAMPLE)!;
  const h = holdersOf(snap, TOP, `${TOP}/src/auth/signin.ts`, false);

  it("names the first holder and counts the rest", () => {
    expect(tagLabel(h)).toBe("monocode-57 +1");
    expect(tagLabel(h.slice(0, 1))).toBe("monocode-57");
    expect(tagLabel([])).toBe("");
  });

  it("shows who, where, when and the note on hover", () => {
    const text = tagTooltip(h, false, NOW);
    expect(text).toContain(
      "monocode-57 is editing this file on main, last edit 4m ago",
    );
    expect(text).toContain("Note (20m ago): adding rate limit to sign-in");
    expect(text).toContain(
      `monocode-12 is editing this file in another worktree (${OTHER}), last edit just now`,
    );
    const folder = tagTooltip(
      holdersOf(snap, TOP, `${TOP}/src`, true),
      true,
      NOW,
    );
    expect(folder).toContain("2 files in this folder");
  });

  it("colours by agent", () => {
    expect(tagTone("monocode-03")).toBe("claude");
    expect(tagTone("codex")).toBe("codex");
    expect(tagTone("dsh-4")).toBe("other");
    expect(tagTone("12345")).toBe("other");
  });

  it("says how long ago, short", () => {
    expect(ago(NOW - 30_000, NOW)).toBe("now");
    expect(ago(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(ago(NOW - 125 * 60_000, NOW)).toBe("2h");
    expect(ago(NOW + 60_000, NOW)).toBe("now");
  });
});
