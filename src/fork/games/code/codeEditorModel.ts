import type { DrillLanguage } from "./codeModel";

/**
 * Fork: the Code tab's editor, without CodeMirror. Everything here is plain
 * data so the completion list and the Python formatter's finishing pass can
 * be checked without a browser.
 */

const JAVASCRIPT_WORDS = [
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "new",
  "class",
  "extends",
  "this",
  "true",
  "false",
  "null",
  "undefined",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "map",
  "filter",
  "reduce",
  "forEach",
  "find",
  "some",
  "every",
  "split",
  "join",
  "slice",
  "splice",
  "includes",
  "indexOf",
  "length",
  "push",
  "pop",
  "shift",
  "unshift",
  "sort",
  "reverse",
  "concat",
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Math.max",
  "Math.min",
  "Math.floor",
  "Math.ceil",
  "Math.round",
  "Math.abs",
  "Number",
  "String",
  "Boolean",
  "Array",
  "JSON.stringify",
  "JSON.parse",
  "console.log",
];

const PYTHON_WORDS = [
  "def",
  "return",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "in",
  "not",
  "and",
  "or",
  "is",
  "None",
  "True",
  "False",
  "import",
  "from",
  "as",
  "class",
  "try",
  "except",
  "finally",
  "raise",
  "with",
  "lambda",
  "yield",
  "pass",
  "break",
  "continue",
  "global",
  "nonlocal",
  "assert",
  "del",
  "range",
  "len",
  "list",
  "dict",
  "set",
  "str",
  "int",
  "float",
  "bool",
  "enumerate",
  "zip",
  "sorted",
  "sum",
  "min",
  "max",
  "abs",
  "round",
  "print",
  "input",
  "type",
  "isinstance",
  "map",
  "filter",
  "open",
];

/** A fake path, only used to borrow the file editor's language setup. */
export function drillPath(language: DrillLanguage): string {
  return language === "python" ? "drill.py" : "drill.js";
}

/** JS is two spaces; Python's block indent is four. */
export function indentFor(language: DrillLanguage): string {
  return language === "python" ? "    " : "  ";
}

/**
 * The drill language's keywords and common built-ins, followed by every word
 * already in the document. Completion should feel like a nudge, not a manual.
 */
export function completionWords(language: DrillLanguage, text: string): string[] {
  const builtins = language === "python" ? PYTHON_WORDS : JAVASCRIPT_WORDS;
  const seen = new Set(builtins);
  const words = [...builtins];
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const word = match[0];
    if (!seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words;
}

/** Whether a line starts and ends inside a multi-line string. */
export type StringEdges = { start: boolean; end: boolean };

/**
 * Python's last formatting pass: no trailing whitespace, no run of blank lines
 * at the end, and exactly one final newline. Text inside a string is its
 * value, so a line that starts in one keeps its `original` indent and a line
 * that ends in one keeps its trailing spaces.
 */
export function finishPythonSource(
  source: string,
  inString: readonly StringEdges[] = [],
  original?: string,
): string {
  const before = original?.split("\n");
  const lines = source.split("\n").map((line, index) => {
    const edges = inString[index];
    const kept = edges?.start && before?.[index] !== undefined ? before[index] : line;
    return edges?.end ? kept : kept.replace(/[ \t]+$/, "");
  });
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
