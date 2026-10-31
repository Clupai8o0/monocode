import { describe, expect, it } from "vitest";
import {
  ago,
  drillLanguageFor,
  drillSlug,
  loadSnapshot,
  loadSubmissionCode,
  loadSubmissions,
  parsePicks,
  pickPrompt,
  problemState,
  saveSnapshot,
  snapshotForDojo,
  syncLeetcode,
} from "./leetcodeAccount";
import type { LeetcodeFetch } from "./leetcode";

function question(slug: string, status: string) {
  return {
    titleSlug: slug,
    title: slug.toUpperCase(),
    frontendId: "7",
    questionStatus: status,
    difficulty: "MEDIUM",
    numSubmitted: 2,
    lastSubmittedAt: "2026-10-01T10:00:00+00:00",
    topicTags: [{ name: "Array" }],
  };
}

describe("syncLeetcode", () => {
  it("pages through progress and recent submissions and reads the profile", async () => {
    const calls: string[] = [];
    const fetch: LeetcodeFetch = async (kind, value) => {
      calls.push(`${kind}:${value}`);
      if (kind === "progress") {
        const skip = Number(value);
        const questions =
          skip === 0
            ? Array.from({ length: 100 }, (_, i) => question(`p${i}`, i % 2 ? "ATTEMPTED" : "SOLVED"))
            : [question("last", "SOLVED")];
        return { userProgressQuestionList: { totalNum: 101, questions } };
      }
      if (kind === "recent") {
        return {
          submissionList: {
            hasNext: value === "0",
            submissions: [
              { id: `s${value}`, titleSlug: "two-sum", title: "Two Sum", statusDisplay: "Accepted", lang: "python3", timestamp: "1700000000" },
              { id: "", titleSlug: "broken" },
            ],
          },
        };
      }
      return {
        matchedUser: {
          submitStatsGlobal: {
            acSubmissionNum: [
              { difficulty: "All", count: 51 },
              { difficulty: "Easy", count: 20 },
              { difficulty: "Medium", count: 30 },
              { difficulty: "Hard", count: 1 },
            ],
          },
          tagProblemCounts: {
            fundamental: [{ tagName: "Array", problemsSolved: 3 }],
            advanced: [{ tagName: "Trie", problemsSolved: 9 }],
          },
        },
      };
    };
    const snapshot = await syncLeetcode(fetch, "sam", 5);
    expect(calls).toEqual(["progress:0", "progress:100", "recent:0", "recent:20", "profile:"]);
    expect(snapshot.solved).toHaveLength(51);
    expect(snapshot.attempted).toHaveLength(50);
    expect(snapshot.solved[0]).toMatchObject({ slug: "p0", difficulty: "medium", tags: ["Array"], submissions: 2 });
    expect(snapshot.recent.map((item) => item.id)).toEqual(["s0", "s20"]);
    expect(snapshot.solvedCount).toEqual({ easy: 20, medium: 30, hard: 1 });
    expect(snapshot.tags[0]).toEqual({ tag: "Trie", solved: 9 });
    expect(snapshot.syncedAt).toBe(5);
    expect(JSON.parse(snapshotForDojo(snapshot)).syncedAt).toBe("1970-01-01T00:00:00.005Z");
  });

  it("says when LeetCode signed the user out", async () => {
    const fetch: LeetcodeFetch = async () => ({ userProgressQuestionList: null });
    await expect(syncLeetcode(fetch, "sam")).rejects.toThrow("signed you out");
  });
});

describe("picks and state", () => {
  it("keeps well-formed picks once each, in order", () => {
    expect(
      parsePicks(
        JSON.stringify([
          { slug: "Two-Sum", why: " hashing " },
          { slug: "two-sum" },
          { slug: "../etc" },
          { why: "no slug" },
          { slug: "3sum" },
        ]),
      ),
    ).toEqual([
      { slug: "two-sum", why: "hashing" },
      { slug: "3sum", why: "" },
    ]);
    expect(parsePicks(JSON.stringify({ picks: [{ slug: "a" }] }))).toEqual([{ slug: "a", why: "" }]);
    expect(parsePicks("not json")).toEqual([]);
  });

  it("reads a drill's slug and a problem's state", () => {
    expect(drillSlug("lc-two-sum-js")).toBe("two-sum");
    expect(drillSlug("lc-3sum-py")).toBe("3sum");
    expect(drillSlug("add-two")).toBeNull();
    const snapshot = {
      username: "sam",
      syncedAt: 0,
      solvedCount: { easy: 0, medium: 0, hard: 0 },
      solved: [{ slug: "a", title: "A", number: "1", difficulty: "easy", tags: [], submissions: 1, lastSubmitted: null }],
      attempted: [{ slug: "b", title: "B", number: "2", difficulty: "easy", tags: [], submissions: 1, lastSubmitted: null }],
      recent: [],
      tags: [],
    };
    expect(problemState(snapshot, "a")).toBe("solved");
    expect(problemState(snapshot, "b")).toBe("tried");
    expect(problemState(snapshot, "c")).toBeNull();
    expect(problemState(null, "a")).toBeNull();

    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    saveSnapshot(snapshot, storage);
    expect(loadSnapshot(storage)?.username).toBe("sam");
    saveSnapshot(null, storage);
    expect(loadSnapshot(storage)).toBeNull();
  });
});

describe("submissions", () => {
  it("lists newest first and loads code", async () => {
    const fetch: LeetcodeFetch = async (kind) =>
      kind === "submissions"
        ? {
            questionSubmissionList: {
              submissions: [
                { id: "1", titleSlug: "a", statusDisplay: "Wrong Answer", lang: "cpp", timestamp: "10" },
                { id: "2", titleSlug: "a", statusDisplay: "Accepted", lang: "python3", timestamp: "20" },
              ],
            },
          }
        : { submissionDetails: { code: "print(1)", lang: { name: "python3" } } };
    const list = await loadSubmissions(fetch, "a");
    expect(list.map((item) => item.id)).toEqual(["2", "1"]);
    expect(await loadSubmissionCode(fetch, "2")).toEqual({ code: "print(1)", lang: "python3" });
    await expect(loadSubmissions(async () => ({}), "a")).rejects.toThrow("signed you out");
    await expect(loadSubmissionCode(async () => ({ submissionDetails: null }), "2")).rejects.toThrow();
  });

  it("maps languages and times", () => {
    expect(drillLanguageFor("python3")).toBe("python");
    expect(drillLanguageFor("javascript")).toBe("javascript");
    expect(drillLanguageFor("typescript")).toBeNull();
    expect(ago(1000 - 120, 1000 * 1000)).toBe("2m ago");
    expect(ago(0, 7200 * 1000)).toBe("2h ago");
    expect(ago(10, 30 * 1000)).toBe("just now");
    expect(ago(0, 3 * 86400 * 1000)).toBe("3d ago");
    expect(pickPrompt("/d")).toContain("/d/leetcode-picks.json");
  });
});

describe("verdicts", () => {
  it("reads judged submissions and waits while pending", async () => {
    const { readVerdict, waitForVerdict, verdictLine } = await import("./leetcodeAccount");
    expect(readVerdict({ submissionDetails: null })).toBeNull();
    expect(readVerdict({ submissionDetails: { statusCode: 0 } })).toBeNull();
    const accepted = readVerdict({
      submissionDetails: { statusCode: 10, totalCorrect: 63, totalTestcases: 63, runtimeDisplay: "52 ms", memoryDisplay: "17.1 MB" },
    });
    expect(accepted && verdictLine(accepted)).toBe("Accepted · 63/63 tests · 52 ms · 17.1 MB");
    const wrong = readVerdict({
      submissionDetails: {
        statusCode: 11,
        totalCorrect: 2,
        totalTestcases: 63,
        lastTestcase: "[3,3]\n6",
        expectedOutput: "[0,1]",
        codeOutput: "[]",
      },
    });
    expect(wrong?.accepted).toBe(false);
    expect(wrong && verdictLine(wrong)).toBe("Wrong Answer · 2/63 tests");
    expect(wrong?.detail).toBe("Input: [3,3], 6\nExpected: [0,1]\nGot: []");
    expect(readVerdict({ submissionDetails: { statusCode: 20, compileError: "Line 1: oops" } })?.detail).toBe(
      "Line 1: oops",
    );

    let calls = 0;
    const fetch: LeetcodeFetch = async () => {
      calls += 1;
      return calls < 3 ? { submissionDetails: null } : { submissionDetails: { statusCode: 14 } };
    };
    const verdict = await waitForVerdict(fetch, "9", { wait: async () => undefined });
    expect(verdict.status).toBe("Time Limit Exceeded");
    expect(calls).toBe(3);
    await expect(
      waitForVerdict(async () => ({}), "9", { tries: 2, wait: async () => undefined }),
    ).rejects.toThrow("still judging");
  });
});
