import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/styles/index.css";
import { CodeTable, type RunCode } from "../../src/fork/games/code/CodeTable";
import { gamesPanel } from "../../src/fork/games/gamesPanelStore";
import type { LeetcodeFetch } from "../../src/fork/games/code/leetcode";
import {
  OPEN_DOJO_EVENT,
  type CodeRunResult,
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
  {
    id: "py-add",
    title: "Add two numbers in Python",
    topic: "logic",
    level: "easy",
    language: "python",
    task: "Write add(a, b) so it gives back a plus b.",
    starter: "def add(a, b):\n  return 0\n",
    tests: [{ call: "add(1, 2)", expect: "3" }],
    hints: ["Return the sum.", "return a + b"],
    solution: "def add(a, b):\n    return a + b\n",
  },
];

// Stands in for fork_leetcode_fetch: two-sum works, tree is turned away.
const fetchLeetcode: LeetcodeFetch = async (kind, value) => {
  if (kind !== "question") {
    return {};
  }
  if (value === "tree") {
    return {
      question: {
        titleSlug: "tree",
        isPaidOnly: false,
        content: "<p>A tree problem.</p>",
        metaData: JSON.stringify({
          name: "depth",
          params: [{ name: "root", type: "TreeNode" }],
          return: { type: "integer" },
        }),
      },
    };
  }
  return {
    question: {
      questionFrontendId: "1",
      title: "Two Sum",
      titleSlug: "two-sum",
      difficulty: "Easy",
      isPaidOnly: false,
      content:
        "<p>Return the indices of the two numbers that add up to target.</p>" +
        "<p><strong>Input:</strong> nums = [2,7,11,15], target = 9</p>\n" +
        "<p><strong>Output:</strong> [0,1]</p>\n" +
        "<p><strong>Input:</strong> nums = [3,2,4], target = 6</p>\n" +
        "<p><strong>Output:</strong> [1,2]</p>",
      hints: [],
      metaData: JSON.stringify({
        name: "twoSum",
        params: [
          { name: "nums", type: "integer[]" },
          { name: "target", type: "integer" },
        ],
        return: { type: "integer[]" },
      }),
      codeSnippets: [
        { langSlug: "javascript", code: "var twoSum = function(nums, target) {\n    \n};" },
      ],
      topicTags: [{ name: "Array" }],
    },
  };
};

const runCode: RunCode = async (_language, source) => {
  const lines: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
  };
  try {
    new Function("console", source)(fakeConsole);
    return {
      stdout: lines.join("\n"),
      stderr: "",
      timedOut: false,
      exitCode: 0,
      truncated: false,
    };
  } catch (error) {
    return {
      stdout: lines.join("\n"),
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      exitCode: 1,
      truncated: false,
    };
  }
};

// The lab runner always reports cut output, so the notice has some output
// to sit above.
const labRunCode: RunCode = async (language, source) => {
  if (scriptedRun) {
    return scriptedRun;
  }
  const outcome = await runCode(language, source);
  return { ...outcome, stdout: `earlier lines\n${outcome.stdout}`, truncated: true };
};

// A check can hand the table the exact stdout and stderr a run would produce.
let scriptedRun: CodeRunResult | null = null;

function setScriptedRun(result: Partial<CodeRunResult> | null) {
  scriptedRun = result
    ? {
        stdout: "",
        stderr: "",
        timedOut: false,
        exitCode: 0,
        truncated: false,
        ...result,
      }
    : null;
}

// Stands in for the panel's game keys: editor typing must never reach it.
const page = window as unknown as {
  gameKeys: string[];
  dojoOpened: boolean;
  lab?: Lab;
};
page.gameKeys = [];
page.dojoOpened = false;
window.addEventListener("keydown", (event) => {
  page.gameKeys.push(event.key);
});
window.addEventListener(OPEN_DOJO_EVENT, () => {
  page.dojoOpened = true;
});

/** One drill Dojo writes after the tab was first opened. */
function dojoDrill(title: string): Drill {
  return {
    id: "js-add",
    title,
    topic: "logic",
    level: "easy",
    language: "javascript",
    task: "A drill Dojo wrote while the Code tab was hidden.",
    starter: "function add(a, b) {\n  // a later starter\n}\n",
    tests: [{ call: "add(1, 2)", expect: "3" }],
    hints: [],
    solution: "function add(a, b) {\n  return a + b;\n}\n",
  };
}

type Lab = {
  setActive: (active: boolean) => void;
  newRun: () => void;
  setDojoTitle: (title: string) => void;
  setDojoAvailable: (available: boolean) => void;
  setRunResult: (result: Partial<CodeRunResult> | null) => void;
  openPanel: () => void;
  panelOpen: () => boolean;
  loads: () => number;
  dojoOpened: () => boolean;
};

/** The mutable page the browser checks drive through `window.lab`. */
function LabHarness() {
  const [active, setActive] = useState(false);
  const [runId, setRunId] = useState(0);
  const [dojoAvailable, setDojoAvailable] = useState(true);
  const extra = useRef<Drill[]>([]);
  const loads = useRef(0);
  const loadExtraDrills = useCallback(async () => {
    loads.current += 1;
    return { drills: extra.current, invalid: [] };
  }, []);
  page.lab = {
    setActive,
    newRun: () => setRunId((value) => value + 1),
    setDojoTitle: (title) => {
      extra.current = [dojoDrill(title)];
    },
    setDojoAvailable,
    setRunResult: setScriptedRun,
    openPanel: () => {
      gamesPanel.hide();
      gamesPanel.toggle();
    },
    panelOpen: () => gamesPanel.isOpen(),
    loads: () => loads.current,
    dojoOpened: () => page.dojoOpened,
  };
  return (
    <div
      className="text-content"
      style={{ width: 720, height: 560, margin: "24px auto" }}
    >
      <CodeTable
        mode="low"
        runId={runId}
        active={active}
        runCode={labRunCode}
        loadExtraDrills={loadExtraDrills}
        hasDojo={() => dojoAvailable}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  params.get("lab") === "1" ? (
    <LabHarness />
  ) : (
    <div
      className="text-content"
      style={{ width: 720, height: 560, margin: "24px auto" }}
    >
      <CodeTable
        mode="low"
        runId={0}
        runCode={runCode}
        drills={drills}
        hasDojo={() => true}
        fetchLeetcode={fetchLeetcode}
      />
    </div>
  ),
);
