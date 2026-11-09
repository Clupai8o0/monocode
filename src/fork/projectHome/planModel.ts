/**
 * Fork feature: Project home. Reads a project's roadmap table from
 * `docs/plan.md` (Kickoff's format, or any table with a Phase/Step column and
 * a "Done when" column) and writes phase status back into the same table, so
 * every chat and agent sees one source of truth.
 *
 * Status lives in an optional Status column: `Built (Phase 1 chat, 8 Nov)`.
 * A done-when check starting with ✓ counts as met.
 */

export type PhaseStatus = "todo" | "progress" | "built" | "blocked" | "done";

export const PHASE_STATUSES: PhaseStatus[] = [
  "todo",
  "progress",
  "built",
  "blocked",
  "done",
];

export const PHASE_STATUS_LABEL: Record<PhaseStatus, string> = {
  todo: "Not started",
  progress: "In progress",
  built: "Built",
  blocked: "Blocked",
  done: "Done",
};

export type PlanCheck = { text: string; met: boolean };

export type PlanPhase = {
  id: string;
  name: string;
  what: string;
  checks: PlanCheck[];
  status: PhaseStatus;
  /** Who set the status and when, from the parentheses after it. */
  statusNote: string;
};

export type Plan = {
  title: string;
  phases: PlanPhase[];
  hasStatusColumn: boolean;
};

/** Where a project's roadmap may live, in the order they are tried. */
export const PLAN_FILES = [
  "docs/plan.md",
  "plan.md",
  "docs/roadmap.md",
  "ROADMAP.md",
];

export const DEFAULT_PLAN_FILE = PLAN_FILES[0];

const ID_HEADERS = /^(phase|step|stage|milestone|#|id|no\.?)$/;
const WHAT_HEADERS = /^(what|change|scope|description|details|goal)$/;
const MET = /^(✓|✔|✅|\[x\])\s*/i;

function plain(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRow(line: string): boolean {
  return line.trim().startsWith("|");
}

function isSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/** Cells of a table row; `\|` stays inside a cell. */
export function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (body.endsWith("|") && !body.endsWith("\\|")) {
    body = body.slice(0, -1);
  }
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function joinRow(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

type Table = {
  header: number;
  rows: number[];
  idCol: number;
  whatCol: number;
  doneCol: number;
  statusCol: number;
};

function headerOf(cells: string[]) {
  const names = cells.map((cell) => plain(cell).toLowerCase());
  return {
    whatCol: names.findIndex((name, i) => i > 0 && WHAT_HEADERS.test(name)),
    doneCol: names.findIndex((name) => name.includes("done when")),
    statusCol: names.findIndex((name) => name === "status"),
    idLike: ID_HEADERS.test(names[0] ?? ""),
  };
}

/** The roadmap table: the first one with a "Done when" column, else the first with a Phase/Step column. */
function findTable(lines: string[]): Table | null {
  let fallback: Table | null = null;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isRow(lines[i]) || !isSeparator(lines[i + 1])) {
      continue;
    }
    const head = headerOf(splitRow(lines[i]));
    const rows: number[] = [];
    let j = i + 2;
    while (j < lines.length && isRow(lines[j])) {
      rows.push(j);
      j++;
    }
    const table = {
      header: i,
      rows,
      idCol: 0,
      whatCol: head.whatCol,
      doneCol: head.doneCol,
      statusCol: head.statusCol,
    };
    if (head.doneCol >= 0 && (head.idLike || head.doneCol > 0)) {
      return table;
    }
    if (head.idLike && !fallback) {
      fallback = table;
    }
    i = j - 1;
  }
  return fallback;
}

const ID_CELL = /^(?:(?:phase|step|stage|milestone)\s+)?((?:[A-Za-z]{1,2})?\d+(?:\.\d+)*[a-z]?)[.:)]?(?:\s+[-–—·:]?\s*(.*))?$/i;

/** Splits "Open fast, no lag at 10,000 words; Sam likes it" into checks. */
export function splitChecks(text: string): PlanCheck[] {
  const body = plain(text);
  if (!body) {
    return [];
  }
  return body
    .split(/;\s+|,\s+(?:and\s+)?(?=\D)/)
    .map((part) => part.trim().replace(/^and\s+/i, ""))
    .filter(Boolean)
    .map((part) => {
      const met = MET.test(part);
      const text = part.replace(MET, "").replace(/[.;,]$/, "");
      return { text: text.charAt(0).toUpperCase() + text.slice(1), met };
    });
}

export function parseStatus(cell: string): {
  status: PhaseStatus;
  note: string;
} {
  const text = plain(cell);
  const note = /\(([^)]*)\)\s*$/.exec(text)?.[1]?.trim() ?? "";
  const word = text.replace(/\([^)]*\)\s*$/, "").trim().toLowerCase();
  let status: PhaseStatus = "todo";
  if (/^(✅\s*)?(done|complete|completed|shipped|merged)\b/.test(word)) {
    status = "done";
  } else if (/^built\b|not merged|in review|^review/.test(word)) {
    status = "built";
  } else if (/^blocked|^waiting|^on hold/.test(word)) {
    status = "blocked";
  } else if (/^(in progress|progress|doing|started|wip|active)\b/.test(word)) {
    status = "progress";
  }
  return { status, note };
}

function phaseFrom(cells: string[], table: Table, index: number): PlanPhase {
  const first = plain(cells[table.idCol] ?? "");
  const whatCell = table.whatCol >= 0 ? plain(cells[table.whatCol] ?? "") : "";
  const match = ID_CELL.exec(first);
  let id = match ? match[1] : String(index + 1);
  let name = match ? (match[2] ?? "").trim() : first;
  let what = whatCell;
  if (!name) {
    // "# | Change | Why": the id column holds only the number.
    name = whatCell;
    what = "";
  }
  if (!match && !first) {
    id = String(index + 1);
  }
  if (!what) {
    const colon = name.indexOf(": ");
    if (colon > 0 && colon < 60) {
      what = name.slice(colon + 2);
      name = name.slice(0, colon);
    }
  }
  const status = table.statusCol >= 0
    ? parseStatus(cells[table.statusCol] ?? "")
    : { status: "todo" as PhaseStatus, note: "" };
  return {
    id,
    name,
    what,
    checks: table.doneCol >= 0 ? splitChecks(cells[table.doneCol] ?? "") : [],
    status: status.status,
    statusNote: status.note,
  };
}

export function parsePlan(text: string): Plan | null {
  const lines = text.split(/\r?\n/);
  const table = findTable(lines);
  if (!table) {
    return null;
  }
  const phases = table.rows
    .map((row, i) => phaseFrom(splitRow(lines[row]), table, i))
    .filter((phase) => phase.name);
  if (phases.length === 0) {
    return null;
  }
  const title = lines.find((line) => /^#\s+/.test(line));
  return {
    title: title ? plain(title.replace(/^#\s+/, "")) : "",
    phases,
    hasStatusColumn: table.statusCol >= 0,
  };
}

function cellText(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/**
 * Returns `text` with the phase's Status cell set, adding a Status column to
 * the table when it has none. Returns null when the phase is not found.
 */
export function setPhaseStatus(
  text: string,
  phaseId: string,
  status: PhaseStatus,
  note: string,
): string | null {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const table = findTable(lines);
  if (!table) {
    return null;
  }
  const rowIndex = table.rows.findIndex(
    (row, i) => phaseFrom(splitRow(lines[row]), table, i).id === phaseId,
  );
  if (rowIndex < 0) {
    return null;
  }
  const width = splitRow(lines[table.header]).length;
  let statusCol = table.statusCol;
  if (statusCol < 0) {
    statusCol = width;
    lines[table.header] = joinRow([...splitRow(lines[table.header]), "Status"]);
    lines[table.header + 1] = joinRow([
      ...splitRow(lines[table.header + 1]),
      "---",
    ]);
  }
  table.rows.forEach((row, i) => {
    const cells = splitRow(lines[row]);
    while (cells.length <= statusCol) {
      cells.push("");
    }
    if (i === rowIndex) {
      const label = PHASE_STATUS_LABEL[status];
      cells[statusCol] = note ? `${label} (${cellText(note)})` : label;
    } else if (table.statusCol >= 0) {
      return;
    }
    lines[row] = joinRow(cells);
  });
  return lines.join(newline);
}

/** The phase the project is on: the first in progress, else the first not done. */
export function currentPhase(phases: PlanPhase[]): PlanPhase | null {
  return (
    phases.find((phase) => phase.status === "progress") ??
    phases.find((phase) => phase.status !== "done") ??
    null
  );
}

export function doneCount(phases: PlanPhase[]): number {
  return phases.filter((phase) => phase.status === "done").length;
}

/** "8 Nov", for status notes. */
export function shortDate(now: Date = new Date()): string {
  return now.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The phase a chat title names, e.g. "Phase 2 Full Markdown" or "M1 taste loop". */
export function phaseForTitle(
  title: string,
  phases: PlanPhase[],
): PlanPhase | null {
  const text = title.toLowerCase();
  const byId = /\b(?:phase|step|stage|milestone)\s+([a-z]{0,2}\d+(?:\.\d+)*)\b/i.exec(text)
    ?? /^([a-z]{1,2}\d+(?:\.\d+)*)\b/i.exec(text);
  if (byId) {
    const hit = phases.find((phase) => phase.id.toLowerCase() === byId[1]);
    if (hit) {
      return hit;
    }
  }
  const named = phases
    .filter((phase) => phase.name.length >= 6)
    .sort((a, b) => b.name.length - a.name.length)
    .find((phase) => text.includes(phase.name.toLowerCase()));
  return named ?? null;
}

const STATUS_RULES = `Status is one of: Not started, In progress, Built (works, not merged yet), Blocked, Done. Write who set it and when in brackets, e.g. \`Built (Phase 1 chat, 8 Nov)\`.`;

/** The prompt that asks a project's chat to fill in its roadmap for the Project home. */
export function fillPlanPrompt(planFile: string | null): string {
  const file = planFile ?? DEFAULT_PLAN_FILE;
  const start = planFile
    ? `Update the roadmap table in ${file} so MonoCode's Project home can show it.`
    : `This project has no roadmap yet. Write one in ${file} so MonoCode's Project home can show it. Base it on the README, .claude/handoff.md, git log and the code; keep it to the phases that matter (usually 4 to 10).`;
  return [
    start,
    "",
    "The table needs these columns: `| Phase | What | Done when | Status |`.",
    "- Phase: an id and a short name, e.g. `2 Full Markdown`. Keep the ids that are there.",
    "- Done when: the checks, separated by `; `. Put ✓ before each check that is already met.",
    `- ${STATUS_RULES}`,
    "- Judge status and checks from evidence: git log, merged branches, tests, the handoff and the code. When unsure, leave it Not started and say so.",
    "",
    "Change nothing else in the file. Commit only that file, and only if this repo's CLAUDE.md lets you commit without asking. Reply with the table and anything you were unsure about.",
  ].join("\n");
}

/** The first message of a chat started from a phase card. */
export function startPhasePrompt(planFile: string, phase: PlanPhase): string {
  const checks = phase.checks.map((check) => `- ${check.met ? "✓ " : ""}${check.text}`);
  return [
    `Work on Phase ${phase.id} · ${phase.name} from ${planFile}.`,
    phase.what ? `What: ${phase.what}` : "",
    checks.length ? `Done when:\n${checks.join("\n")}` : "",
    "",
    `Keep its row in ${planFile} current: set Status to In progress now, Built when it works, Done once merged. ${STATUS_RULES} Put ✓ before each done-when check you meet.`,
  ]
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join("\n");
}
