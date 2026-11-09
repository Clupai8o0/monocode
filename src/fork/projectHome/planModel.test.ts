import { describe, expect, it } from "vitest";
import {
  currentPhase,
  doneCount,
  fillPlanPrompt,
  parsePlan,
  parseStatus,
  phaseForTitle,
  setPhaseStatus,
  splitChecks,
  startPhasePrompt,
} from "./planModel";

const YAP = `# Yap: plan

**See the feel first.**

| Phase | What | Done when |
|---|---|---|
| 0.0 Mockups | Clickable looks (Kickoff, in chat) | Sam picks a look |
| 0.2 Feel test | Measure opening | Open to typing under 1 s, no typing lag at 10,000 words, Sam likes the feel |
| 1 Daily writer | New note on every open | Sam can journal offline, reopen attached screenshots/files, and nothing is lost after killing the app |
| 4 Rewards | Closing moment | Each note grows a plant; everything can be turned off |

## Open questions

| Question | Who |
|---|---|
| Final name | Sam |
`;

const GLOW = `# Glow up

| Step | Done when |
|---|---|
| 0.1 Monorepo scaffold: pnpm + Turborepo, \`apps/web\` | \`pnpm test\` and \`pnpm lint\` pass |
| 0.2 Vercel + Neon: project in \`syd1\` | \`/api/health\` returns 200 |
`;

const JOBBIRD = `| Step | What | Done when | Status |
| --- | --- | --- | --- |
| M1 Taste loop | review | ✓ your answers change the ranking | Done (Sam, 2 Nov) |
| M2 Spend cap | cap \\| warn | a run that could pass the cap is refused | In progress |
`;

const CSTACK = `# Roadmap

| # | Change | Why | Size |
|---|---|---|---|
| 1 | Interfaces doc | MonoCode parses these | M |
| 2 | Find claims.py | Fixed path today | S |
`;

describe("parsePlan", () => {
  it("reads Kickoff's Phase | What | Done when table and skips later tables", () => {
    const plan = parsePlan(YAP);
    expect(plan?.title).toBe("Yap: plan");
    expect(plan?.hasStatusColumn).toBe(false);
    expect(plan?.phases.map((phase) => phase.id)).toEqual(["0.0", "0.2", "1", "4"]);
    expect(plan?.phases[0]).toMatchObject({
      name: "Mockups",
      what: "Clickable looks (Kickoff, in chat)",
      status: "todo",
    });
  });

  it("splits done-when into checks without breaking numbers", () => {
    const plan = parsePlan(YAP);
    expect(plan?.phases[1].checks.map((check) => check.text)).toEqual([
      "Open to typing under 1 s",
      "No typing lag at 10,000 words",
      "Sam likes the feel",
    ]);
    expect(plan?.phases[2].checks).toHaveLength(3);
    expect(plan?.phases[3].checks.map((check) => check.text)).toEqual([
      "Each note grows a plant",
      "Everything can be turned off",
    ]);
  });

  it("splits a Step cell with a colon into name and what", () => {
    const plan = parsePlan(GLOW);
    expect(plan?.phases[0]).toMatchObject({
      id: "0.1",
      name: "Monorepo scaffold",
      what: "pnpm + Turborepo, apps/web",
    });
  });

  it("reads lettered ids, a Status column, notes, ticks and escaped pipes", () => {
    const plan = parsePlan(JOBBIRD);
    expect(plan?.hasStatusColumn).toBe(true);
    expect(plan?.phases[0]).toMatchObject({
      id: "M1",
      name: "Taste loop",
      status: "done",
      statusNote: "Sam, 2 Nov",
    });
    expect(plan?.phases[0].checks[0]).toEqual({
      text: "Your answers change the ranking",
      met: true,
    });
    expect(plan?.phases[1]).toMatchObject({ status: "progress", what: "cap | warn" });
  });

  it("takes the name from the next column when the id column holds only a number", () => {
    const plan = parsePlan(CSTACK);
    expect(plan?.phases.map((phase) => [phase.id, phase.name])).toEqual([
      ["1", "Interfaces doc"],
      ["2", "Find claims.py"],
    ]);
  });

  it("suffixes duplicate parsed phase ids in table order", () => {
    const dup = `# Plan

| Phase | What | Done when |
|---|---|---|
| 1 Alpha | first | Met |
| Phase 1 Beta | second | Met |
| 1 Gamma | third | Met |
| 2 Unique | ok | Met |
`;
    const plan = parsePlan(dup);
    expect(plan?.phases.map((phase) => [phase.id, phase.name])).toEqual([
      ["1", "Alpha"],
      ["1-2", "Beta"],
      ["1-3", "Gamma"],
      ["2", "Unique"],
    ]);
  });

  it("returns null without a roadmap table", () => {
    expect(parsePlan("# Notes\n\nJust text.\n\n| Question | Who |\n|---|---|\n| A | B |\n")).toBeNull();
  });

  it("ignores a roadmap-shaped table inside fenced code blocks", () => {
    const fenced = `# Plan

\`\`\`markdown
| Phase | What | Done when |
|---|---|---|
| 99 | Example only | Not the real plan |
\`\`\`

~~~text
| Step | Done when |
|---|---|
| X | Still ignored |
~~~

| Phase | What | Done when |
|---|---|---|
| 1 | Real phase | Ship it |
`;
    const plan = parsePlan(fenced);
    expect(plan?.phases.map((phase) => phase.id)).toEqual(["1"]);
    expect(plan?.phases[0].name).toBe("Real phase");
  });

  it("uses CommonMark fences: nested shorter close, 4-space indent, unclosed", () => {
    const nested = `# Plan

\`\`\`\`markdown
\`\`\`js
const x = 1;
\`\`\`
| Phase | What | Done when |
|---|---|---|
| 99 | Example only | Ignored |
| Phase | What | Done when |
|---|---|---|
| 98 | Still inside fence | Ignored |
\`\`\`\`

| Phase | What | Done when |
|---|---|---|
| 1 Ship search | find articles | Results load |
| 2 Polish | UI | Ship |
`;
    const plan = parsePlan(nested);
    expect(plan?.phases.map((phase) => [phase.id, phase.name])).toEqual([
      ["1", "Ship search"],
      ["2", "Polish"],
    ]);
    const next = setPhaseStatus(nested, "1", "progress", "chat, 9 Nov");
    expect(next).not.toBeNull();
    expect(parsePlan(next ?? "")?.phases[0].status).toBe("progress");
    // The example inside the fence is left as it was.
    expect(next).toContain("| 99 | Example only | Ignored |\n");
    expect(next).toMatch(/\| 1 Ship search \|[^\n]*\| In progress/);

    // Four spaces of indent is code, not a fence, so the table after it counts.
    const indented = `    \`\`\`
| Phase | What | Done when |
|---|---|---|
| 1 Real | after an indented line | Met |
`;
    expect(parsePlan(indented)?.phases.map((phase) => phase.id)).toEqual(["1"]);

    // An unclosed fence runs to the end, hiding any table after it.
    const unclosed = `~~~
| Phase | What | Done when |
|---|---|---|
| 1 Hidden | inside | Met |
`;
    expect(parsePlan(unclosed)).toBeNull();

    // A sample in an indented fence (say, nested in a list) is not the roadmap.
    const sample = `- Example:
    \`\`\`
    | Phase | What | Done when |
    |---|---|---|
    | 99 | Example only | Ignored |
    \`\`\`

| Phase | What | Done when |
|---|---|---|
| 1 Real | work | Done |
`;
    expect(parsePlan(sample)?.phases.map((phase) => phase.id)).toEqual(["1"]);
    expect(setPhaseStatus(sample, "1", "done", "")).toContain("    | 99 | Example only | Ignored |\n");
  });

  it("assigns fallback ids without colliding with explicit ids", () => {
    const mixed = `# Plan

| Phase | What | Done when |
|---|---|---|
| Setup | bootstrap repo | Tests pass |
| 1 Ship search | search UX | Fast results |
| Configure | settings page | Saved |
| 3 Deploy | prod | Live |
`;
    const plan = parsePlan(mixed);
    expect(plan?.phases.map((phase) => [phase.id, phase.name])).toEqual([
      ["2", "Setup"],
      ["1", "Ship search"],
      ["4", "Configure"],
      ["3", "Deploy"],
    ]);
  });
});

describe("parseStatus", () => {
  it("maps loose words onto the five statuses", () => {
    expect(parseStatus("Built, not merged").status).toBe("built");
    expect(parseStatus("**Blocked** (waiting on Sam)")).toEqual({
      status: "blocked",
      note: "waiting on Sam",
    });
    expect(parseStatus("WIP").status).toBe("progress");
    expect(parseStatus("✅ Done").status).toBe("done");
    expect(parseStatus("").status).toBe("todo");
  });
});

describe("setPhaseStatus", () => {
  it("adds a Status column and sets one row", () => {
    const next = setPhaseStatus(YAP, "1", "built", "Sam, 8 Nov");
    expect(next).not.toBeNull();
    const plan = parsePlan(next ?? "");
    expect(plan?.hasStatusColumn).toBe(true);
    expect(plan?.phases.map((phase) => phase.status)).toEqual(["todo", "todo", "built", "todo"]);
    expect(plan?.phases[2].statusNote).toBe("Sam, 8 Nov");
    expect(next).toContain("| Phase | What | Done when | Status |");
    expect(next).toContain("## Open questions\n\n| Question | Who |");
  });

  it("changes only the target row when the column exists", () => {
    const next = setPhaseStatus(JOBBIRD, "M2", "done", "") ?? "";
    expect(next.split("\n")[2]).toBe(JOBBIRD.split("\n")[2]);
    expect(parsePlan(next)?.phases[1].status).toBe("done");
    expect(parsePlan(next)?.phases[1].what).toBe("cap | warn");
  });

  it("returns null for an unknown phase", () => {
    expect(setPhaseStatus(YAP, "9", "done", "")).toBeNull();
  });

  it("updates the row that matches a suffixed duplicate id", () => {
    const dup = `| Phase | What | Done when | Status |
|---|---|---|---|
| 1 Alpha | first | Met | |
| Phase 1 Beta | second | Met | |
`;
    const next = setPhaseStatus(dup, "1-2", "built", "chat, 9 Nov");
    expect(next).not.toBeNull();
    const plan = parsePlan(next ?? "");
    expect(plan?.phases.map((phase) => [phase.id, phase.status])).toEqual([
      ["1", "todo"],
      ["1-2", "built"],
    ]);
    expect(plan?.phases[1].statusNote).toBe("chat, 9 Nov");
  });

  it("resolves the target row by name when the table changed under a stale id", () => {
    const shifted = `| Phase | What | Done when | Status |
|---|---|---|---|
| 1 Prep | warmup | Ready | |
| Phase 1 Ship search | UX | Results | |
| 2 Polish | UI | Ship | |
`;
    const next = setPhaseStatus(shifted, "1", "built", "agent, 9 Nov", "Ship search");
    expect(next).not.toBeNull();
    expect(parsePlan(next ?? "")?.phases[1]).toMatchObject({
      id: "1-2",
      name: "Ship search",
      status: "built",
    });
    // Renumbered to 2, but the only Polish: that is the phase that was clicked.
    const renamed = setPhaseStatus(shifted, "1", "built", "agent, 9 Nov", "Polish");
    expect(parsePlan(renamed ?? "")?.phases[2]).toMatchObject({ id: "2", status: "built" });
    expect(setPhaseStatus(shifted, "1", "built", "", "Missing")).toBeNull();
  });

  it("finds a phase by name when its id is gone, but never guesses", () => {
    // Alpha was deleted, so Beta (shown as 1-2) is now plain 1.
    const renumbered = `| Phase | What | Done when | Status |
|---|---|---|---|
| Phase 1 Beta | second | Met | |
| 2 Gamma | third | Met | |
`;
    const next = setPhaseStatus(renumbered, "1-2", "built", "", "Beta");
    expect(parsePlan(next ?? "")?.phases[0]).toMatchObject({ id: "1", status: "built" });

    // Two rows named Beta under the same base id: no safe pick.
    const twice = `| Phase | What | Done when | Status |
|---|---|---|---|
| 1 Beta | a | Met | |
| 1 Gamma | b | Met | |
| 1 Beta | c | Met | |
`;
    expect(setPhaseStatus(twice, "1-2", "built", "", "Beta")).toBeNull();
  });

  it("adds Status after the widest row without clobbering an extra body cell", () => {
    const uneven = `# Plan

| Phase | What | Done when |
|---|---|---|
| 1 | Alpha | Met when |
| 2 | Beta | Met when | extra note |
`;
    const next = setPhaseStatus(uneven, "2", "progress", "");
    expect(next).toContain("| extra note | In progress |");
    expect(next).not.toContain("| In progress | extra note");
    expect(next).toContain("| --- | --- | --- | --- | --- |");
    expect(parsePlan(next ?? "")?.phases[1]).toMatchObject({
      status: "progress",
      name: "Beta",
    });
  });
});

describe("helpers", () => {
  it("finds the current phase and counts done", () => {
    const plan = parsePlan(setPhaseStatus(JOBBIRD, "M2", "done", "") ?? "");
    expect(doneCount(plan?.phases ?? [])).toBe(2);
    expect(currentPhase(plan?.phases ?? [])).toBeNull();
    expect(currentPhase(parsePlan(JOBBIRD)?.phases ?? [])?.id).toBe("M2");
    expect(currentPhase(parsePlan(YAP)?.phases ?? [])?.id).toBe("0.0");
  });

  it("matches chat titles to phases", () => {
    const phases = parsePlan(YAP)?.phases ?? [];
    expect(phaseForTitle("Phase 1 Daily writer", phases)?.id).toBe("1");
    expect(phaseForTitle("Feel test numbers", phases)?.id).toBe("0.2");
    expect(phaseForTitle("Fix the build", phases)).toBeNull();
    expect(phaseForTitle("M1 polish", parsePlan(JOBBIRD)?.phases ?? [])?.id).toBe("M1");
  });

  it("matches suffixed duplicate ids in chat titles", () => {
    const phases =
      parsePlan(`| Phase | What | Done when |
|---|---|---|
| 1 Alpha | first | Met |
| Phase 1 Beta | second | Met |
`)?.phases ?? [];
    expect(phaseForTitle("Phase 1-2 Beta", phases)?.id).toBe("1-2");
    expect(phaseForTitle("Phase 1-3 Unknown", phases)?.id).toBe("1");
    expect(phaseForTitle("Phase 1 Alpha", phases)?.id).toBe("1");

    const lettered =
      parsePlan(`| Phase | What | Done when |
|---|---|---|
| 1a Alpha | first | Met |
| Phase 1a Beta | second | Met |
`)?.phases ?? [];
    expect(phaseForTitle("Phase 1a-2 Beta", lettered)?.id).toBe("1a-2");
  });

  it("matches phase names on word boundaries only", () => {
    const plan = parsePlan(`| Phase | What | Done when |
|---|---|---|
| 1 Writer | daily | Ship |
| 2 Search | find things | Ship |
`);
    const phases = plan?.phases ?? [];
    expect(phaseForTitle("Research indexing", phases)).toBeNull();
    expect(phaseForTitle("Improve Search ranking", phases)?.id).toBe("2");
    expect(phaseForTitle("Daily writer flow", phases)?.id).toBe("1");
  });

  it("splits checks with and-lists and tick marks", () => {
    expect(splitChecks("✓ A works, and B works")).toEqual([
      { text: "A works", met: true },
      { text: "B works", met: false },
    ]);
  });

  it("writes prompts that name the file and the status rules", () => {
    expect(fillPlanPrompt(null)).toContain("no roadmap yet");
    expect(fillPlanPrompt("docs/roadmap.md")).toContain("docs/roadmap.md");
    const phase = parsePlan(YAP)?.phases[2];
    const prompt = startPhasePrompt("docs/plan.md", phase!);
    expect(prompt).toContain("Phase 1 · Daily writer");
    expect(prompt).toContain("- Sam can journal offline");
    expect(prompt).toContain("Built (Phase 1 chat, 8 Nov)");
  });
});
