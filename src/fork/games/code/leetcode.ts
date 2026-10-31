import { validateDrills, type Drill, type DrillLevel, type DrillTest } from "./codeModel";

/**
 * Fork: LeetCode problems as Code tab drills. LeetCode's public API gives
 * the task, the starter code and the examples, but not a judge, so the
 * examples' outputs become the drill's tests and the run stays local.
 * Only plain functions over numbers, strings, booleans and lists work;
 * linked lists, trees and class-design problems are turned away.
 */

/** What the native side asks LeetCode for (fork_leetcode_fetch). */
export type LeetcodeFetch = (kind: string, value: string) => Promise<unknown>;

export type LeetcodeRequest =
  | { kind: "daily" }
  | { kind: "random"; level: DrillLevel }
  | { kind: "question"; slug: string }
  | { kind: "number"; number: string };

export type LeetcodeQuestion = {
  questionFrontendId?: string;
  title?: string;
  titleSlug?: string;
  difficulty?: string;
  isPaidOnly?: boolean;
  content?: string | null;
  hints?: string[];
  metaData?: string;
  exampleTestcaseList?: string[];
  codeSnippets?: { langSlug: string; code: string }[] | null;
  topicTags?: { name: string }[];
};

type Param = { name: string; type: string };
type Meta = { name: string; params: Param[]; returnType: string };

export const LEETCODE_STORE_KEY = "monocode:fork-code-leetcode";
const KEEP = 60;
const RANDOM_TRIES = 6;

/** A number, a problem link, a slug or a title, or null when it is none. */
export function parseLeetcodeInput(text: string): LeetcodeRequest | null {
  const value = text.trim();
  if (!value) {
    return null;
  }
  if (/^\d{1,6}$/.test(value)) {
    return { kind: "number", number: value };
  }
  const link = /leetcode\.(?:com|cn)\/problems\/([a-z0-9-]+)/i.exec(value);
  if (link) {
    return { kind: "question", slug: link[1].toLowerCase() };
  }
  const slug = value
    .toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? { kind: "question", slug } : null;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  le: "≤",
  ge: "≥",
  ne: "≠",
  times: "×",
  minus: "-",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** LeetCode's problem HTML as plain text that reads well in the tab. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/\r/g, "")
    .replace(/<sup>\s*([\s\S]*?)\s*<\/sup>/gi, "^$1")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|pre|ul|ol|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^\t+/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const BASE_TYPES = new Set(["integer", "long", "double", "boolean", "string", "character"]);

/** The item type under any lists: "list<double[]>" is "double". */
export function baseType(type: string): string {
  let rest = type.trim();
  for (;;) {
    const list = /^list<(.+)>$/.exec(rest);
    if (list) {
      rest = list[1].trim();
      continue;
    }
    if (rest.endsWith("[]")) {
      rest = rest.slice(0, -2);
      continue;
    }
    return rest;
  }
}

/** True for the types a JSON-like literal can carry: numbers, text, lists. */
export function supportedType(type: string): boolean {
  return BASE_TYPES.has(baseType(type));
}

/** How many lists deep: "integer" 0, "integer[]" 1, "list<string[]>" 2. */
function listDepth(type: string): number {
  let depth = 0;
  let rest = type.trim();
  for (;;) {
    const list = /^list<(.+)>$/.exec(rest);
    if (list) {
      rest = list[1].trim();
      depth++;
      continue;
    }
    if (rest.endsWith("[]")) {
      rest = rest.slice(0, -2);
      depth++;
      continue;
    }
    return depth;
  }
}

function isListType(type: string): boolean {
  return type.endsWith("[]") || type.startsWith("list<");
}

function readMeta(raw: string | undefined): Meta | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    return "LeetCode did not say how its function is called.";
  }
  if (!parsed || typeof parsed !== "object") {
    return "LeetCode did not say how its function is called.";
  }
  const meta = parsed as Record<string, unknown>;
  if (meta.systemdesign || meta.classname) {
    return "It is a class-design problem; the Code tab runs single functions for now.";
  }
  const params = Array.isArray(meta.params) ? meta.params : null;
  const ret = meta.return as Record<string, unknown> | undefined;
  if (typeof meta.name !== "string" || !params || !ret || typeof ret.type !== "string") {
    return "LeetCode did not say how its function is called.";
  }
  const list: Param[] = [];
  for (const param of params) {
    const row = param as Record<string, unknown>;
    if (typeof row?.name !== "string" || typeof row.type !== "string") {
      return "LeetCode did not say how its function is called.";
    }
    list.push({ name: row.name, type: row.type });
  }
  if (ret.type === "void") {
    return "It changes its input in place, which the Code tab cannot check yet.";
  }
  const odd = [...list.map((param) => param.type), ret.type].find((type) => !supportedType(type));
  if (odd) {
    return `It uses ${odd}, which the Code tab cannot build yet.`;
  }
  return { name: meta.name, params: list, returnType: ret.type };
}

function isLiteral(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Splits "nums = [2,7], target = 9" by the parameter names, in order. */
export function splitInput(text: string, names: string[]): string[] | null {
  const values: string[] = [];
  let at = 0;
  for (let index = 0; index < names.length; index++) {
    const head = `${names[index]} = `;
    if (!text.startsWith(head, at)) {
      return null;
    }
    const start = at + head.length;
    let end = text.length;
    if (index + 1 < names.length) {
      end = text.indexOf(`, ${names[index + 1]} = `, start);
      if (end < 0) {
        return null;
      }
      at = end + 2;
    }
    values.push(text.slice(start, end).trim());
  }
  return values;
}

/** Each example's argument literals and expected output literal. */
export function readExamples(
  text: string,
  names: string[],
  testcases: string[] = [],
): { args: string[]; output: string }[] {
  const found: { input: string; output: string }[] = [];
  // An output can run over several lines (a list printed one row a line);
  // it ends at a blank line, the explanation or the next example.
  const pattern =
    /Input:\s*([^\n]*)\n\s*Output:\s*([\s\S]*?)(?=\n\s*\n|\n\s*Explanation:|\n\s*Example|$)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    found.push({ input: match[1].trim(), output: match[2].replace(/\s*\n\s*/g, "").trim() });
  }
  const examples: { args: string[]; output: string }[] = [];
  found.forEach((example, index) => {
    let args = splitInput(example.input, names);
    if (!args && testcases.length === found.length) {
      const lines = testcases[index].split("\n").map((line) => line.trim());
      args = lines.length === names.length ? lines : null;
    }
    if (args && args.every(isLiteral) && isLiteral(example.output)) {
      examples.push({ args, output: example.output });
    }
  });
  return examples;
}

/** A JSON literal as Python: true, false and null outside strings change. */
export function toPython(literal: string): string {
  let out = "";
  let index = 0;
  while (index < literal.length) {
    const char = literal[index];
    if (char === '"') {
      let end = index + 1;
      while (end < literal.length && literal[end] !== '"') {
        end += literal[end] === "\\" ? 2 : 1;
      }
      out += literal.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const word = /^[a-z]+/.exec(literal.slice(index));
    if (word) {
      out += word[0] === "true" ? "True" : word[0] === "false" ? "False" : word[0] === "null" ? "None" : word[0];
      index += word[0].length;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

const LEVELS: Record<string, DrillLevel> = { Easy: "easy", Medium: "mid", Hard: "hard" };

function pythonStarter(code: string): string {
  let starter = code.replace(/\s+$/, "");
  if (starter.endsWith(":")) {
    const lastLine = starter.slice(starter.lastIndexOf("\n") + 1);
    const indent = /^\s*/.exec(lastLine)?.[0] ?? "";
    starter += `\n${indent}    pass`;
  }
  return `${withPythonImports(starter)}\n`;
}

// What LeetCode's Python imports for every answer, by the names that need it.
const PY_STAR_IMPORTS: [RegExp, string][] = [
  [/\b(List|Optional|Dict|Tuple|Set|Deque)\[/, "typing"],
  [/(?<![.\w])(Counter|defaultdict|deque|OrderedDict)\b/, "collections"],
  [/(?<![.\w])(heappush|heappop|heapify|heappushpop|nlargest|nsmallest)\b/, "heapq"],
  [/(?<![.\w])(bisect_left|bisect_right|insort)\b/, "bisect"],
  [/(?<![.\w])(lru_cache|cache|reduce|cmp_to_key)\b/, "functools"],
  [/(?<![.\w])(accumulate|permutations|combinations|product|pairwise|zip_longest)\b/, "itertools"],
];
const PY_MODULES = ["math", "heapq", "bisect", "collections", "itertools", "functools", "re", "string"];

/**
 * Python code as LeetCode runs it: the imports it adds for every answer, put
 * at the top so code written there (List[int], deque, math.inf) runs here.
 */
export function withPythonImports(code: string): string {
  const lines: string[] = [];
  for (const [pattern, module] of PY_STAR_IMPORTS) {
    const line = `from ${module} import *`;
    if (pattern.test(code) && !code.includes(line)) {
      lines.push(line);
    }
  }
  const modules = PY_MODULES.filter(
    (module) =>
      new RegExp(`(?<![.\\w])${module}\\.`).test(code) &&
      !new RegExp(`^\\s*import [^\\n]*\\b${module}\\b`, "m").test(code),
  );
  if (modules.length) {
    lines.push(`import ${modules.join(", ")}`);
  }
  if (!lines.length) {
    return code;
  }
  // __future__ imports must stay first, so ours go after them.
  const future = /^(?:[ \t]*(?:#[^\n]*)?\n|from __future__ import[^\n]*\n)*/.exec(code)?.[0] ?? "";
  const head = /from __future__/.test(future) ? future : "";
  return `${head}${lines.join("\n")}\n\n${code.slice(head.length)}`;
}

/**
 * Whether sorting inside each inner list keeps the answer's meaning. It does
 * for groups and combinations; it does not when two inner lists hold the
 * same items in different orders (permutations), so those keep their order.
 */
export function innerOrderFree(output: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return false;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  const keys = value.map((item) =>
    JSON.stringify(Array.isArray(item) ? [...(item as unknown[])].map((v) => JSON.stringify(v)).sort() : item),
  );
  return new Set(keys).size === keys.length;
}

// Doubles, alone or in lists, pass within 1e-5, absolute or relative, as
// LeetCode's judge does. Close enough gives back the expected value itself.
const JS_CLOSE =
  "((a, b) => { const close = (x, y) => typeof x === \"number\" && typeof y === \"number\" ? Math.abs(x - y) <= 1e-5 * Math.max(1, Math.abs(y)) : Array.isArray(x) && Array.isArray(y) && x.length === y.length && y.every((v, i) => close(x[i], v)); return close(a, b) ? b : a; })";
const PY_CLOSE =
  "(lambda close: (lambda a, b: b if close(close, a, b) else a))(lambda close, x, y: (isinstance(x, (int, float)) and not isinstance(x, bool) and isinstance(y, (int, float)) and abs(x - y) <= 1e-5 * max(1, abs(y))) or (isinstance(x, list) and isinstance(y, list) and len(x) == len(y) and all(close(close, u, v) for u, v in zip(x, y))))";

function tests(
  meta: Meta,
  examples: { args: string[]; output: string }[],
  anyOrder: boolean,
  python: boolean,
): DrillTest[] {
  const isDouble = baseType(meta.returnType) === "double";
  const sorted = anyOrder && isListType(meta.returnType);
  // Inside each inner list, order only stops mattering for groups of words
  // (anagrams); numbers there are pairs, points or permutations.
  const wordGroups =
    listDepth(meta.returnType) === 2 && ["string", "character"].includes(baseType(meta.returnType));
  return examples.map(({ args, output }) => {
    const shown = python ? args.map(toPython) : args;
    const label = `${meta.name}(${shown.join(", ")})`;
    let call = python ? `Solution().${label}` : label;
    let expect = python ? toPython(output) : output;
    if (isDouble) {
      if (sorted && listDepth(meta.returnType) === 1) {
        // Any order: line both lists up smallest first, then compare closely.
        [call, expect] = [call, expect].map((value) =>
          python
            ? `(lambda x: sorted(x) if isinstance(x, list) else x)(${value})`
            : `((x) => Array.isArray(x) ? [...x].sort((p, q) => p - q) : x)(${value})`,
        );
      }
      call = python ? `${PY_CLOSE}(${call}, ${expect})` : `${JS_CLOSE}(${call}, ${expect})`;
    } else if (sorted) {
      const inner = wordGroups && innerOrderFree(output);
      [call, expect] = [call, expect].map((value) =>
        python
          ? `(lambda x: sorted(json.dumps(${inner ? "sorted(v) if isinstance(v, list) else v" : "v"}) for v in x) if isinstance(x, list) else x)(${value})`
          : `((x) => Array.isArray(x) ? x.map((v) => JSON.stringify(${inner ? "Array.isArray(v) ? [...v].sort() : v" : "v"})).sort() : x)(${value})`,
      );
    }
    return { call, expect, label };
  });
}

/** Drills for this problem (JavaScript and Python), or why it can't be one. */
export function leetcodeDrills(question: LeetcodeQuestion): { drills: Drill[] } | { problem: string } {
  const slug = question.titleSlug ?? "";
  if (question.isPaidOnly || !question.content) {
    return { problem: "It is a LeetCode Premium problem." };
  }
  const meta = readMeta(question.metaData);
  if (typeof meta === "string") {
    return { problem: meta };
  }
  const text = htmlToText(question.content);
  const examples = readExamples(
    text,
    meta.params.map((param) => param.name),
    question.exampleTestcaseList ?? [],
  );
  if (!examples.length) {
    return { problem: "Its examples could not be read as tests." };
  }
  if (
    /\b(?:return|output) any (?!order)/i.test(text) ||
    /\bany (?:of them|one of them|valid \w+|such \w+) (?:is|will be) accepted/i.test(text)
  ) {
    return { problem: "It accepts more than one right answer, so its examples cannot judge it." };
  }
  const anyOrder = /any order|order (of [a-z ]+ )?does not matter/i.test(text);
  const snippets = question.codeSnippets ?? [];
  const title = question.questionFrontendId
    ? `${question.questionFrontendId}. ${question.title ?? slug}`
    : (question.title ?? slug);
  const tag = question.topicTags?.[0]?.name;
  const base = {
    title,
    topic: tag ? `LeetCode · ${tag}` : "LeetCode",
    level: LEVELS[question.difficulty ?? ""] ?? "mid",
    task: text,
    hints: (question.hints ?? []).map(htmlToText).filter(Boolean),
    solution: `This problem's answer is not shipped here. Solutions on LeetCode: https://leetcode.com/problems/${slug}/solutions/`,
  };
  const drills: Drill[] = [];
  const js = snippets.find((snippet) => snippet.langSlug === "javascript");
  if (js) {
    drills.push({
      ...base,
      id: `lc-${slug}-js`,
      language: "javascript",
      starter: `${js.code.replace(/\s+$/, "")}\n`,
      tests: tests(meta, examples, anyOrder, false),
    });
  }
  const py = snippets.find((snippet) => snippet.langSlug === "python3");
  if (py) {
    drills.push({
      ...base,
      id: `lc-${slug}-py`,
      language: "python",
      starter: pythonStarter(py.code),
      tests: tests(meta, examples, anyOrder, true),
    });
  }
  if (!drills.length) {
    return { problem: "LeetCode has no JavaScript or Python starter for it." };
  }
  return { drills };
}

function field(data: unknown, ...path: string[]): unknown {
  let at: unknown = data;
  for (const key of path) {
    if (!at || typeof at !== "object") {
      return undefined;
    }
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

async function questionDrills(fetch: LeetcodeFetch, slug: string): Promise<{ drills: Drill[] } | { problem: string }> {
  const question = field(await fetch("question", slug), "question");
  if (!question || typeof question !== "object") {
    return { problem: "LeetCode has no problem by that name." };
  }
  return leetcodeDrills(question as LeetcodeQuestion);
}

const DIFFICULTY: Record<DrillLevel, string> = { easy: "EASY", mid: "MEDIUM", hard: "HARD" };

/** Fetches a problem and turns it into drills. Throws with a readable reason. */
export async function loadLeetcode(fetch: LeetcodeFetch, request: LeetcodeRequest): Promise<Drill[]> {
  const fail = (reason: string): never => {
    throw new Error(reason);
  };
  let slug: string | null = null;
  if (request.kind === "question") {
    slug = request.slug;
  } else if (request.kind === "daily") {
    const value = field(await fetch("daily", ""), "activeDailyCodingChallengeQuestion", "question", "titleSlug");
    slug = typeof value === "string" ? value : fail("LeetCode did not send today's problem.");
  } else if (request.kind === "number") {
    const list = field(await fetch("number", request.number), "questionList", "data");
    const hit = Array.isArray(list)
      ? (list as Record<string, unknown>[]).find((row) => row?.questionFrontendId === request.number)
      : undefined;
    slug = typeof hit?.titleSlug === "string" ? hit.titleSlug : fail(`LeetCode has no problem ${request.number}.`);
  } else {
    for (let attempt = 0; attempt < RANDOM_TRIES; attempt++) {
      const pick = field(await fetch("random", DIFFICULTY[request.level]), "randomQuestion");
      const pickSlug = field(pick, "titleSlug");
      if (typeof pickSlug !== "string" || field(pick, "isPaidOnly") === true) {
        continue;
      }
      const result = await questionDrills(fetch, pickSlug);
      if ("drills" in result) {
        return result.drills;
      }
    }
    return fail(`No ${request.level} problem the Code tab can run turned up. Try again.`);
  }
  const result = await questionDrills(fetch, slug);
  if ("problem" in result) {
    return fail(`${slug}: ${result.problem}`);
  }
  return result.drills;
}

/** LeetCode drills fetched before, newest first, so reviews can come back to them. */
export function loadSavedLeetcode(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Drill[] {
  try {
    const raw = storage?.getItem(LEETCODE_STORE_KEY);
    return raw ? validateDrills(JSON.parse(raw) as unknown).drills : [];
  } catch {
    return [];
  }
}

export function saveLeetcode(
  fresh: readonly Drill[],
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
): void {
  const ids = new Set(fresh.map((drill) => drill.id));
  const kept = [...fresh, ...loadSavedLeetcode(storage).filter((drill) => !ids.has(drill.id))];
  try {
    storage?.setItem(LEETCODE_STORE_KEY, JSON.stringify(kept.slice(0, KEEP)));
  } catch {
    // Full storage only means the drill is not kept for next time.
  }
}
