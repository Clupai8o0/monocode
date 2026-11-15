import type { Block, HarnessId } from "../../features/sessions/model/session";

/**
 * Fork: a shell call that hands work to another model ("Codex builds the
 * tour", `second_opinion.py --ladder grok:grok-4.7`) shows that model's mark
 * instead of the generic run icon.
 */

/** Model and tool names, as people write them in a call's description. */
const NAMES: ReadonlyArray<[RegExp, HarnessId]> = (
  [
    ["codex|gpt-?\\d[\\w.]*(?:-[a-z]+)?", "codex"],
    ["deepseek|dsh", "deepseek"],
    ["grok", "grok"],
    ["cursor-agent|cursor|composer-\\d[\\w.]*", "cursor"],
    ["gemini|antigravity|agy", "antigravity"],
    ["opencode|glm|qwen|minimax", "opencode"],
    ["claude|opus|sonnet|haiku", "claude"],
  ] as const
).map(([names, harness]): [RegExp, HarnessId] => [
  // A whole word: `claude-sessions` or `codex.ts` is a tool or file name.
  new RegExp(`(?<![\\w.-])(?:${names})(?![\\w-]|\\.\\w)`, "i"),
  harness,
]);

/** Explicit routes in a command line. */
const ROUTES: ReadonlyArray<[RegExp, HarnessId]> = [
  [/--ladder[ =]+codex\b|(^|[\s;&|(])codex\s+exec\b/, "codex"],
  [/--ladder[ =]+dsh:|(^|[\s;&|(])dsh\s/, "deepseek"],
  [/--ladder[ =]+grok:|(^|[\s;&|(])grok\s+-p\b/, "grok"],
  [/--ladder[ =]+cursor:|(^|[\s;&|(])cursor-agent\s/, "cursor"],
  [/--ladder[ =]+agy:|(^|[\s;&|(])agy\s+-p\b/, "antigravity"],
  [/--ladder[ =]+opencode:|(^|[\s;&|(])opencode\s+run\b/, "opencode"],
];

/** Paths and quoted strings name folders and search terms, not who runs. */
function prose(text: string): string {
  return text
    .replace(/(["'`]).*?\1/g, " ")
    .replace(/\S*[/~]\S*/g, " ")
    .replace(/\S*=\S*/g, " ");
}

function earliest(
  text: string,
  rules: ReadonlyArray<[RegExp, HarnessId]>,
): { at: number; harness: HarnessId } | undefined {
  let best: { at: number; harness: HarnessId } | undefined;
  for (const [pattern, harness] of rules) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.at)) {
      best = { at: match.index, harness };
    }
  }
  return best;
}

export function shellModelHarness(block: Block): HarnessId | undefined {
  const tool = block.tool;
  if (!tool) return undefined;
  // Descriptions read as sentences ("Codex builds..."); command lines
  // ("rg -n codex src") start lower-case and only count through ROUTES.
  const words = [block.text, tool.title]
    .map((text) => text?.trim() ?? "")
    .filter((text) => /^\p{Lu}/u.test(text))
    .map(prose);
  for (const text of words) {
    const named = earliest(text, NAMES);
    if (named) return named.harness;
  }
  const commands = [tool.command, tool.title, block.text].filter(
    (text): text is string => Boolean(text?.trim()),
  );
  for (const text of commands) {
    const routed = earliest(text, ROUTES);
    if (routed) return routed.harness;
  }
  return undefined;
}
