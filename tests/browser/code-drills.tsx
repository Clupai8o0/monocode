import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { CodeTable, type RunCode } from "../../src/fork/games/code/CodeTable";
import {
  OPEN_DOJO_EVENT,
  type Drill,
} from "../../src/fork/games/code/codeModel";

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") {
  document.documentElement.classList.add("theme-light");
}

// Two small drills, run by the fake runner below, which really runs the
// JavaScript the table builds and reports what it printed.
const drills: Drill[] = [
  {
    id: "add-two",
    title: "Add two numbers",
    topic: "logic",
    level: "easy",
    language: "javascript",
    task: "Write add(a, b) so it gives back a plus b.",
    starter: "function add(a, b) {\n  // your code here\n}\n",
    tests: [
      { call: "add(1, 2)", expect: "3" },
      { call: "add(-1, 1)", expect: "0" },
    ],
    hints: ["Return the sum.", "return a + b;"],
    solution: "function add(a, b) {\n  return a + b;\n}\n",
  },
  {
    id: "shout-word",
    title: "Shout a word",
    topic: "strings",
    level: "easy",
    language: "javascript",
    task: "Write shout(word) so it gives the word in capital letters with an exclamation mark at the end.",
    starter: "function shout(word) {\n  // your code here\n}\n",
    tests: [
      { call: "shout(\"hey\")", expect: "\"HEY!\"" },
      { call: "shout(\"Go\")", expect: "\"GO!\"" },
    ],
    hints: ["Strings have toUpperCase().", "Join with +."],
    solution: "function shout(word) {\n  return word.toUpperCase() + \"!\";\n}\n",
  },
];

const runCode: RunCode = async (_language, source) => {
  const lines: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
  };
  try {
    new Function("console", source)(fakeConsole);
    return { stdout: lines.join("\n"), stderr: "", timedOut: false, exitCode: 0 };
  } catch (error) {
    return {
      stdout: lines.join("\n"),
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      exitCode: 1,
    };
  }
};

// Stands in for the panel's game keys: editor typing must never reach it.
const page = window as unknown as { gameKeys: string[]; dojoOpened: boolean };
page.gameKeys = [];
page.dojoOpened = false;
window.addEventListener("keydown", (event) => {
  page.gameKeys.push(event.key);
});
window.addEventListener(OPEN_DOJO_EVENT, () => {
  page.dojoOpened = true;
});

createRoot(document.getElementById("root")!).render(
  <div
    className="text-content"
    style={{ width: 720, height: 560, margin: "24px auto" }}
  >
    <CodeTable mode="low" runId={0} runCode={runCode} drills={drills} />
  </div>,
);
