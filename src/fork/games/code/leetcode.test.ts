import { describe, expect, it } from "vitest";
import {
  LEETCODE_STORE_KEY,
  htmlToText,
  innerOrderFree,
  leetcodeDrills,
  loadLeetcode,
  loadSavedLeetcode,
  parseLeetcodeInput,
  readExamples,
  saveLeetcode,
  splitInput,
  supportedType,
  toPython,
  type LeetcodeFetch,
  type LeetcodeQuestion,
} from "./leetcode";

const META = JSON.stringify({
  name: "twoSum",
  params: [
    { name: "nums", type: "integer[]" },
    { name: "target", type: "integer" },
  ],
  return: { type: "integer[]", size: 2 },
});

// Trimmed from LeetCode's real answer for two-sum (31 Oct 2026).
const TWO_SUM: LeetcodeQuestion = {
  questionFrontendId: "1",
  title: "Two Sum",
  titleSlug: "two-sum",
  difficulty: "Easy",
  isPaidOnly: false,
  content:
    "<p>Return <em>indices</em> of the two numbers.</p>\n<p>You can return the answer in any order.</p>\n" +
    "<p><strong>Example 1:</strong></p>\n<p><strong>Input:</strong> <code>nums = [2,7,11,15], target = 9</code></p>\n\n" +
    "<p><strong>Output:</strong> <code>[0,1]</code></p>\n\n<p><strong>Explanation:</strong> 2 + 7 = 9.</p>\n" +
    "<pre>\n<strong>Input:</strong> nums = [3,3], target = 6\n<strong>Output:</strong> [0,1]\n</pre>\n" +
    "<ul><li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li></ul>",
  hints: ["Try a <code>Map</code>."],
  metaData: META,
  exampleTestcaseList: ["[2,7,11,15]\n9", "[3,3]\n6"],
  codeSnippets: [
    { langSlug: "javascript", code: "var twoSum = function(nums, target) {\n    \n};" },
    {
      langSlug: "python3",
      code: "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ",
    },
  ],
  topicTags: [{ name: "Array" }],
};

const withMeta = (meta: object, extra: Partial<LeetcodeQuestion> = {}): LeetcodeQuestion => ({
  ...TWO_SUM,
  metaData: JSON.stringify(meta),
  ...extra,
});

describe("parseLeetcodeInput", () => {
  it("reads numbers, links, slugs and titles", () => {
    expect(parseLeetcodeInput(" 121 ")).toEqual({ kind: "number", number: "121" });
    expect(parseLeetcodeInput("https://leetcode.com/problems/two-sum/description/")).toEqual({
      kind: "question",
      slug: "two-sum",
    });
    expect(parseLeetcodeInput("valid-parentheses")).toEqual({ kind: "question", slug: "valid-parentheses" });
    expect(parseLeetcodeInput("1. Two Sum")).toEqual({ kind: "question", slug: "two-sum" });
    expect(parseLeetcodeInput("Pow(x, n)")).toEqual({ kind: "question", slug: "pow-x-n" });
    expect(parseLeetcodeInput("   ")).toBeNull();
    expect(parseLeetcodeInput("!!!")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("keeps the words, powers and list marks", () => {
    expect(htmlToText("<p>a &lt;= 10<sup>4</sup>&nbsp;and &#39;x&#39;</p><ul><li>one</li></ul>")).toBe(
      "a <= 10^4 and 'x'\n• one",
    );
  });
});

describe("types and literals", () => {
  it("knows which types it can build", () => {
    for (const type of ["integer", "integer[][]", "list<list<string>>", "character[][]", "double", "long[]"]) {
      expect(supportedType(type)).toBe(true);
    }
    for (const type of ["ListNode", "TreeNode", "list<TreeNode>", "Node", "integer[" ]) {
      expect(supportedType(type)).toBe(false);
    }
  });

  it("turns JSON into Python without touching strings", () => {
    expect(toPython('[true,false,null,"true \\"null\\""]')).toBe('[True,False,None,"true \\"null\\""]');
  });

  it("splits inputs by parameter name", () => {
    expect(splitInput('s = "a", t = "b"', ["s", "t"])).toEqual(['"a"', '"b"']);
    expect(splitInput("nums = [1,2], k = 3", ["nums", "k"])).toEqual(["[1,2]", "3"]);
    expect(splitInput("nums = [1,2]", ["nums", "k"])).toBeNull();
    expect(splitInput("[1,2]", ["nums"])).toBeNull();
  });

  it("reads outputs printed over several lines", () => {
    const text = "Input: c = [1,2], t = 3\nOutput:\n[\n[1,2],\n[3]\n]\n\nConstraints:";
    expect(readExamples(text, ["c", "t"])).toEqual([{ args: ["[1,2]", "3"], output: "[[1,2],[3]]" }]);
  });

  it("falls back to the example test cases when the input line is odd", () => {
    const text = "Input: [1,2], 3\nOutput: 4";
    expect(readExamples(text, ["c", "t"], ["[1,2]\n3"])).toEqual([{ args: ["[1,2]", "3"], output: "4" }]);
    expect(readExamples(text, ["c", "t"])).toEqual([]);
  });
});

describe("leetcodeDrills", () => {
  it("makes a JavaScript and a Python drill from the examples", () => {
    const result = leetcodeDrills(TWO_SUM);
    if (!("drills" in result)) {
      throw new Error(result.problem);
    }
    const [js, py] = result.drills;
    expect(js).toMatchObject({
      id: "lc-two-sum-js",
      title: "1. Two Sum",
      topic: "LeetCode · Array",
      level: "easy",
      language: "javascript",
      hints: ["Try a Map."],
    });
    expect(js.tests.map((test) => test.label)).toEqual(["twoSum([2,7,11,15], 9)", "twoSum([3,3], 6)"]);
    // "any order": both sides are sorted before they are compared.
    expect(js.tests[0].call).toContain(".sort()");
    expect(py.id).toBe("lc-two-sum-py");
    expect(py.tests[0].call).toContain("Solution().twoSum([2,7,11,15], 9)");
    expect(py.starter.startsWith("from typing import *\n\nclass Solution:")).toBe(true);
    expect(py.starter.endsWith("        pass\n")).toBe(true);
    expect(js.task).toContain("10^4");
  });

  it("lets doubles be close, not exact", () => {
    const result = leetcodeDrills(
      withMeta(
        { name: "myPow", params: [{ name: "x", type: "double" }, { name: "n", type: "integer" }], return: { type: "double" } },
        { content: "<p><strong>Input:</strong> x = 2.10000, n = 3\n<strong>Output:</strong> 9.26100\n</p>" },
      ),
    );
    if (!("drills" in result)) {
      throw new Error(result.problem);
    }
    const [js, py] = result.drills;
    expect(js.tests[0].expect).toBe("9.26100");
    expect(py.tests[0].label).toBe("myPow(2.10000, 3)");
    const check = (x: unknown) => new Function("myPow", `return ${js.tests[0].call};`)(() => x);
    expect(check(9.261000004)).toBe(9.261);
    expect(check(9.27)).toBe(9.27);
    expect(check("9.261")).toBe("9.261");
  });

  it("lets lists of doubles be close too", () => {
    const result = leetcodeDrills(
      withMeta(
        { name: "avg", params: [{ name: "n", type: "integer" }], return: { type: "double[]" } },
        { content: "<p><strong>Input:</strong> n = 3\n<strong>Output:</strong> [0.33333,1.00000]\n</p>" },
      ),
    );
    if (!("drills" in result)) {
      throw new Error(result.problem);
    }
    const call = result.drills[0].tests[0].call;
    const check = (x: unknown) => new Function("avg", `return ${call};`)(() => x);
    expect(check([1 / 3, 1])).toEqual([0.33333, 1]);
    expect(check([1 / 3])).toEqual([1 / 3]);
    expect(check([0.4, 1])).toEqual([0.4, 1]);
    // A list with holes is not close to a full one.
    const holes = new Array(2);
    expect(check(holes)).toBe(holes);
  });

  it("sorts doubles first when any order is fine", () => {
    const result = leetcodeDrills(
      withMeta(
        { name: "avg", params: [{ name: "n", type: "integer" }], return: { type: "double[]" } },
        { content: "<p>Return them in any order.</p><p><strong>Input:</strong> n = 2\n<strong>Output:</strong> [1.00000,2.00000]\n</p>" },
      ),
    );
    if (!("drills" in result)) {
      throw new Error(result.problem);
    }
    const { call, expect: wanted } = result.drills[0].tests[0];
    const run = (code: string, x: unknown) => new Function("avg", `return ${code};`)(() => x);
    expect(run(call, [2.000001, 1])).toEqual(run(wanted, null));
    expect(run(call, [2.5, 1])).not.toEqual(run(wanted, null));
  });

  it("keeps the order inside number pairs under any order", () => {
    const points = leetcodeDrills(
      withMeta(
        { name: "closest", params: [{ name: "k", type: "integer" }], return: { type: "integer[][]" } },
        { content: "<p>Return them in any order.</p><p><strong>Input:</strong> k = 1\n<strong>Output:</strong> [[-2,2]]\n</p>" },
      ),
    );
    const words = leetcodeDrills(
      withMeta(
        { name: "group", params: [{ name: "k", type: "integer" }], return: { type: "list<list<string>>" } },
        { content: "<p>Return the answer in any order.</p><p><strong>Input:</strong> k = 1\n<strong>Output:</strong> [[\"eat\",\"tea\"]]\n</p>" },
      ),
    );
    if (!("drills" in points) || !("drills" in words)) {
      throw new Error("no drills");
    }
    const run = (call: string, name: string, x: unknown) => new Function(name, `return ${call};`)(() => x);
    const test = points.drills[0].tests[0];
    expect(run(test.call, "closest", [[2, -2]])).not.toEqual(run(test.expect, "closest", null));
    expect(run(test.call, "closest", [[-2, 2]])).toEqual(run(test.expect, "closest", null));
    const group = words.drills[0].tests[0];
    expect(run(group.call, "group", [["tea", "eat"]])).toEqual(run(group.expect, "group", null));
  });

  it("sorts inside inner lists only when that keeps the meaning", () => {
    expect(innerOrderFree('[["eat","tea"],["bat"]]')).toBe(true);
    expect(innerOrderFree("[[1,2],[2,1]]")).toBe(false);
    expect(innerOrderFree("[0,1]")).toBe(true);
    expect(innerOrderFree("nope")).toBe(false);
  });

  it("says why a problem cannot be a drill", () => {
    const problem = (question: LeetcodeQuestion) => {
      const result = leetcodeDrills(question);
      return "problem" in result ? result.problem : "";
    };
    expect(problem({ ...TWO_SUM, isPaidOnly: true, content: null })).toMatch(/Premium/);
    expect(problem(withMeta({ classname: "LRUCache", methods: [] }))).toMatch(/class-design/);
    expect(problem(withMeta({ name: "f", params: [{ name: "head", type: "ListNode" }], return: { type: "ListNode" } }))).toMatch(
      /ListNode/,
    );
    expect(problem(withMeta({ name: "f", params: [{ name: "nums", type: "integer[]" }], return: { type: "void" } }))).toMatch(
      /in place/,
    );
    expect(problem({ ...TWO_SUM, content: "<p>No examples here.</p>" })).toMatch(/examples/);
    expect(problem({ ...TWO_SUM, content: `${TWO_SUM.content}<p>If there are many, return any of them.</p>` })).toMatch(
      /more than one right answer/,
    );
  });
});

describe("loadLeetcode", () => {
  const fake = (answers: Record<string, unknown[]>): LeetcodeFetch & { calls: string[] } => {
    const calls: string[] = [];
    const fetch = (async (kind: string, value: string) => {
      calls.push(`${kind}:${value}`);
      const queue = answers[kind] ?? [];
      return queue.length > 1 ? queue.shift() : queue[0];
    }) as LeetcodeFetch & { calls: string[] };
    fetch.calls = calls;
    return fetch;
  };

  it("finds today's problem", async () => {
    const fetch = fake({
      daily: [{ activeDailyCodingChallengeQuestion: { question: { titleSlug: "two-sum" } } }],
      question: [{ question: TWO_SUM }],
    });
    expect((await loadLeetcode(fetch, { kind: "daily" })).map((drill) => drill.id)).toEqual([
      "lc-two-sum-js",
      "lc-two-sum-py",
    ]);
    expect(fetch.calls).toEqual(["daily:", "question:two-sum"]);
  });

  it("finds a problem by its number, and only that number", async () => {
    const fetch = fake({
      number: [{ questionList: { data: [{ questionFrontendId: "11", titleSlug: "x" }, { questionFrontendId: "1", titleSlug: "two-sum" }] } }],
      question: [{ question: TWO_SUM }],
    });
    await loadLeetcode(fetch, { kind: "number", number: "1" });
    expect(fetch.calls).toEqual(["number:1", "question:two-sum"]);
    await expect(
      loadLeetcode(fake({ number: [{ questionList: { data: [] } }] }), { kind: "number", number: "9" }),
    ).rejects.toThrow(/no problem 9/);
  });

  it("skips Premium and unsupported picks on Random", async () => {
    const fetch = fake({
      random: [
        { randomQuestion: { titleSlug: "paid", isPaidOnly: true } },
        { randomQuestion: { titleSlug: "tree", isPaidOnly: false } },
        { randomQuestion: { titleSlug: "two-sum", isPaidOnly: false } },
      ],
      question: [
        { question: withMeta({ name: "f", params: [{ name: "r", type: "TreeNode" }], return: { type: "integer" } }) },
        { question: TWO_SUM },
      ],
    });
    const drills = await loadLeetcode(fetch, { kind: "random", level: "mid" });
    expect(drills[0].id).toBe("lc-two-sum-js");
    expect(fetch.calls).toEqual([
      "random:MEDIUM",
      "random:MEDIUM",
      "question:tree",
      "random:MEDIUM",
      "question:two-sum",
    ]);
  });

  it("gives the reason for a named problem it cannot use", async () => {
    await expect(
      loadLeetcode(fake({ question: [{ question: null }] }), { kind: "question", slug: "nope" }),
    ).rejects.toThrow(/no problem by that name/);
  });
});

describe("saved LeetCode drills", () => {
  it("keeps the newest first, without repeats", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const result = leetcodeDrills(TWO_SUM);
    const drills = "drills" in result ? result.drills : [];
    saveLeetcode(drills, storage);
    saveLeetcode([drills[1]], storage);
    expect(loadSavedLeetcode(storage).map((drill) => drill.id)).toEqual(["lc-two-sum-py", "lc-two-sum-js"]);
    expect(loadSavedLeetcode(storage)[0].tests[0].label).toBe("twoSum([2,7,11,15], 9)");
    store.set(LEETCODE_STORE_KEY, "not json");
    expect(loadSavedLeetcode(storage)).toEqual([]);
  });
});

describe("withPythonImports", () => {
  it("adds what LeetCode's Python imports, once", async () => {
    const { withPythonImports } = await import("./leetcode");
    const code = "class Solution:\n    def f(self, a: List[int]) -> int:\n        q = deque(a)\n        return math.floor(heappop(a))\n";
    const out = withPythonImports(code);
    expect(out).toContain("from typing import *");
    expect(out).toContain("from collections import *");
    expect(out).toContain("from heapq import *");
    expect(out).toContain("import math");
    expect(out).not.toContain("import math, heapq");
    expect(withPythonImports(out)).toBe(out);
    expect(withPythonImports("x = collections.Counter()\nimport collections\n")).toBe("x = collections.Counter()\nimport collections\n");
    expect(withPythonImports("def f():\n    return 1\n")).toBe("def f():\n    return 1\n");
  });
});
