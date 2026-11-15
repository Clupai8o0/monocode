# Cursor Multi-Model Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every Cursor turn that edits files, automatically launch read-only Claude + usage-aware peer review sessions, then post a short combined note back into Cursor when both settle.

**Architecture:** Pure helpers in `cursorMultiReview.ts` (pick, prompts, frontend heuristic, pair tracker, fan-in text). App wires busy→idle trigger, `openSessionBeside(..., focusNew: false)`, child settlement, and enqueue onto Cursor’s existing `queuedMessages` drain. Settings kill switch defaults on. Manual Second opinion stays may-fix.

**Tech Stack:** TypeScript/React, Vitest, existing `secondOpinion` helpers, `harnessUsedPercent` / `isLiveHarness` / `isHarnessAvailable`, session message queue.

**Spec:** `docs/superpowers/specs/2026-11-04-cursor-multi-model-review-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `src/features/sessions/model/cursorMultiReview.ts` | Setting-agnostic helpers: frontend heuristic, reviewer pick, read-only prompts, should-trigger gates, pair tracker class, fan-in note + queue message builders |
| `src/features/sessions/model/cursorMultiReview.test.ts` | Unit tests for the above |
| `src/features/settings/model/settings.ts` | `loadCursorMultiReview` / `saveCursorMultiReview` (default `true`) + settings search entry |
| `src/features/settings/ui/SettingsView.tsx` | Toggle under Code review |
| `src/features/sessions/model/session.ts` | Extend `SecondOpinionMeta.kind` with `"cursor-multi-review"` |
| `src/features/sessions/data/sessionStore.ts` | Persist/sanitize the new kind if needed |
| `src/features/sessions/ui/SecondOpinionCard.tsx` | Label “Auto-review” when kind is `cursor-multi-review` |
| `src/app/App.tsx` | `focusNew` on `openSessionBeside`; trigger after Cursor turn settle; launch reviewers; settle children; enqueue fan-in |

**v1 scope note:** Skip auto-review when `remoteProjectFor(cwd)` is set (desktop-only). Document in code comment next to the gate.

---

### Task 1: Settings flag (load/save + default on)

**Files:**
- Modify: `src/features/settings/model/settings.ts` (near `FORMAT_ON_SAVE_*`)
- Modify: `src/features/settings/model/settings.test.ts`
- Modify: `src/features/settings/model/settings.ts` search catalog (`id: "diff-view"` neighbors)

- [ ] **Step 1: Write failing tests for the flag**

Add to `settings.test.ts` (follow `loadFormatOnSave` tests):

```ts
import {
  loadCursorMultiReview,
  saveCursorMultiReview,
  CURSOR_MULTI_REVIEW_DEFAULT,
} from "./settings";

const CURSOR_MULTI_REVIEW_KEY = "monocode.cursorMultiReview";

it("defaults Cursor multi-review on", () => {
  localStorage.removeItem(CURSOR_MULTI_REVIEW_KEY);
  expect(CURSOR_MULTI_REVIEW_DEFAULT).toBe(true);
  expect(loadCursorMultiReview()).toBe(true);
});

it("persists Cursor multi-review off", () => {
  saveCursorMultiReview(false);
  expect(localStorage.getItem(CURSOR_MULTI_REVIEW_KEY)).toBe("0");
  expect(loadCursorMultiReview()).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/features/settings/model/settings.test.ts -t "Cursor multi-review"
```

Expected: FAIL — `loadCursorMultiReview` not exported.

- [ ] **Step 3: Implement flag**

In `settings.ts` after `saveFormatOnSave`:

```ts
const CURSOR_MULTI_REVIEW_KEY = "monocode.cursorMultiReview";

export const CURSOR_MULTI_REVIEW_DEFAULT = true;

export function loadCursorMultiReview(): boolean {
  return readFlag(CURSOR_MULTI_REVIEW_KEY) ?? CURSOR_MULTI_REVIEW_DEFAULT;
}

export function saveCursorMultiReview(value: boolean) {
  writeFlag(CURSOR_MULTI_REVIEW_KEY, value);
}
```

Add search entry near `diff-view`:

```ts
{
  id: "cursor-multi-review",
  section: "chat",
  label: "Review Cursor turns with other models",
  keywords: "cursor review claude second opinion multi model auto-review",
},
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/features/settings/model/settings.test.ts -t "Cursor multi-review"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/model/settings.ts src/features/settings/model/settings.test.ts
git commit -m "$(cat <<'EOF'
Add Cursor multi-review settings flag (default on).

EOF
)"
```

---

### Task 2: Frontend path heuristic + reviewer pick

**Files:**
- Create: `src/features/sessions/model/cursorMultiReview.ts`
- Create: `src/features/sessions/model/cursorMultiReview.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import type { HarnessId } from "./session";
import {
  isFrontendReviewPath,
  pathsLookFrontend,
  pickCursorMultiReviewers,
} from "./cursorMultiReview";

describe("isFrontendReviewPath", () => {
  it("matches UI extensions and path segments", () => {
    expect(isFrontendReviewPath("src/ui/Button.tsx")).toBe(true);
    expect(isFrontendReviewPath("styles/app.scss")).toBe(true);
    expect(isFrontendReviewPath("host/engine.ts")).toBe(false);
  });
});

describe("pickCursorMultiReviewers", () => {
  const live = (id: HarnessId) =>
    id === "claude" || id === "codex" || id === "grok";
  const visible = () => true;

  it("returns Claude plus lowest-usage peer", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: live,
        isVisible: visible,
        usedPercent: (id) => (id === "codex" ? 10 : id === "grok" ? 80 : null),
      }),
    ).toEqual([
      { harness: "claude", role: "claude" },
      { harness: "codex", role: "peer" },
    ]);
  });

  it("falls back codex → grok when usage unknown", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: (id) => id === "claude" || id === "grok" || id === "opencode",
        isVisible: visible,
        usedPercent: () => null,
      }).map((r) => r.harness),
    ).toEqual(["claude", "grok"]);
  });

  it("returns peer-only when Claude is missing", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: (id) => id === "codex",
        isVisible: visible,
        usedPercent: () => 0,
      }),
    ).toEqual([{ harness: "codex", role: "peer" }]);
  });

  it("returns empty when nobody is live", () => {
    expect(
      pickCursorMultiReviewers({
        isLive: () => false,
        isVisible: visible,
        usedPercent: () => null,
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npx vitest run src/features/sessions/model/cursorMultiReview.test.ts
```

- [ ] **Step 3: Implement helpers**

In `cursorMultiReview.ts`:

```ts
import { HARNESSES, HARNESS_TITLE, type HarnessId } from "./session";

const FRONTEND_EXT =
  /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
const FRONTEND_SEG = /(?:^|\/)(?:components|ui|styles)(?:\/|$)/i;
const PEER_FALLBACK: HarnessId[] = ["codex", "grok"];

export type CursorMultiReviewRole = "claude" | "peer";

export type CursorMultiReviewer = {
  harness: HarnessId;
  role: CursorMultiReviewRole;
};

export function isFrontendReviewPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return FRONTEND_EXT.test(normalized) || FRONTEND_SEG.test(normalized);
}

export function pathsLookFrontend(paths: string[]): boolean {
  return paths.some(isFrontendReviewPath);
}

export function pickCursorMultiReviewers(options: {
  isLive: (id: HarnessId) => boolean;
  isVisible: (id: HarnessId) => boolean;
  usedPercent: (id: HarnessId) => number | null;
}): CursorMultiReviewer[] {
  const reviewers: CursorMultiReviewer[] = [];
  if (options.isLive("claude") && options.isVisible("claude")) {
    reviewers.push({ harness: "claude", role: "claude" });
  }

  const peers = HARNESSES.filter(
    (id) =>
      id !== "cursor" &&
      id !== "claude" &&
      options.isVisible(id) &&
      options.isLive(id),
  );
  let peer: HarnessId | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const id of peers) {
    const used = options.usedPercent(id);
    if (used == null || !Number.isFinite(used)) continue;
    if (used < best) {
      best = used;
      peer = id;
    }
  }
  if (!peer) {
    for (const id of PEER_FALLBACK) {
      if (peers.includes(id)) {
        peer = id;
        break;
      }
    }
  }
  if (!peer && peers[0]) peer = peers[0];
  if (peer) reviewers.push({ harness: peer, role: "peer" });
  return reviewers;
}

export { HARNESS_TITLE };
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run src/features/sessions/model/cursorMultiReview.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/features/sessions/model/cursorMultiReview.ts src/features/sessions/model/cursorMultiReview.test.ts
git commit -m "$(cat <<'EOF'
Add Cursor multi-reviewer pick and frontend path heuristic.

EOF
)"
```

---

### Task 3: Read-only prompts + should-trigger gates

**Files:**
- Modify: `src/features/sessions/model/cursorMultiReview.ts`
- Modify: `src/features/sessions/model/cursorMultiReview.test.ts`
- Modify: `src/features/sessions/model/session.ts` (`SecondOpinionMeta.kind`)

- [ ] **Step 1: Extend SecondOpinionMeta kind**

In `session.ts`:

```ts
export type SecondOpinionMeta = {
  from: HarnessId;
  to: HarnessId;
  request?: string;
  files?: number;
  /** Split-pane continue, or auto Cursor multi-review. Default is second-opinion. */
  kind?: "handoff" | "cursor-multi-review";
};
```

If `sessionStore.ts` sanitizes `kind`, allow `"cursor-multi-review"` the same way as `"handoff"`.

- [ ] **Step 2: Failing tests for prompts and gates**

```ts
import type { Block } from "./session";
import {
  buildCursorMultiReviewPrompt,
  buildCursorMultiReviewFanInText,
  shouldStartCursorMultiReview,
  CURSOR_MULTI_REVIEW_APP_PREFIX,
} from "./cursorMultiReview";

function user(id: string, text: string, extra: Partial<Block> = {}): Block {
  return { id, role: "user", text, ...extra };
}
function assistant(id: string, text: string): Block {
  return { id, role: "assistant", text };
}
function edit(id: string, path: string): Block {
  return {
    id,
    role: "tool",
    text: `Edited ${path}`,
    tool: {
      kind: "edit",
      title: `Edited ${path}`,
      status: "completed",
      preview: { kind: "write", path, fileName: path.split("/").pop() },
    },
  };
}

describe("buildCursorMultiReviewPrompt", () => {
  it("forbids edits and adds frontend focus for Claude", () => {
    const prompt = buildCursorMultiReviewPrompt({
      from: "cursor",
      to: "claude",
      role: "claude",
      userRequest: "Polish the settings row",
      report: "Updated SettingsView",
      files: ["src/features/settings/ui/SettingsView.tsx"],
      frontendFocus: true,
    });
    expect(prompt).toMatch(/do not modify files/i);
    expect(prompt).not.toMatch(/Fix anything you agree is broken/);
    expect(prompt).toMatch(/UI\/UX|a11y|layout/i);
  });

  it("keeps peer prompt general", () => {
    const prompt = buildCursorMultiReviewPrompt({
      from: "cursor",
      to: "codex",
      role: "peer",
      userRequest: "x",
      report: "y",
      files: ["src/features/settings/ui/SettingsView.tsx"],
      frontendFocus: true,
    });
    expect(prompt).not.toMatch(/UI\/UX|a11y|layout/i);
  });
});

describe("shouldStartCursorMultiReview", () => {
  const turn = [
    user("u1", "fix footer"),
    assistant("a1", "done"),
    edit("e1", "src/app/shell/UsageFooter.tsx"),
  ];

  it("requires setting, cursor harness, edits, and no in-flight pair", () => {
    expect(
      shouldStartCursorMultiReview({
        enabled: true,
        harness: "cursor",
        turn,
        turnUserBlockId: "u1",
        hasInFlightPair: false,
        worktreeRemoved: false,
        isRemote: false,
      }),
    ).toBe(true);
    expect(
      shouldStartCursorMultiReview({
        enabled: false,
        harness: "cursor",
        turn,
        turnUserBlockId: "u1",
        hasInFlightPair: false,
        worktreeRemoved: false,
        isRemote: false,
      }),
    ).toBe(false);
  });

  it("skips fan-in app turns", () => {
    const fanIn = [
      user("u2", "Multi-review ready", {
        appRequestId: `${CURSOR_MULTI_REVIEW_APP_PREFIX}abc`,
      }),
      edit("e2", "src/x.ts"),
    ];
    expect(
      shouldStartCursorMultiReview({
        enabled: true,
        harness: "cursor",
        turn: fanIn,
        turnUserBlockId: "u2",
        hasInFlightPair: false,
        worktreeRemoved: false,
        isRemote: false,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
npx vitest run src/features/sessions/model/cursorMultiReview.test.ts
```

- [ ] **Step 4: Implement prompts + gates**

Reuse `turnUserRequest` / `turnReport` / `turnEditedFiles` / `limitSection` patterns from `secondOpinion.ts`. Core prompt body:

```ts
import { limitSection } from "../../../shared/lib/jsonText";
import {
  turnEditedFiles,
  turnReport,
  turnUserRequest,
  buildSecondOpinionCard,
} from "./secondOpinion";
import type { Block, SecondOpinionMeta } from "./session";

export const CURSOR_MULTI_REVIEW_APP_PREFIX = "cursor-multi-review-";
export const CURSOR_MULTI_REVIEW_TITLE_PREFIX = "Review · ";
const USER_LIMIT = 400;
const REPORT_LIMIT = 900;
const PROMPT_LIMIT = 1_800;
const CHILD_REPORT_LIMIT = 3_000;

export function buildCursorMultiReviewPrompt(input: {
  from: HarnessId;
  to: HarnessId;
  role: CursorMultiReviewRole;
  userRequest: string;
  report: string;
  files: string[];
  frontendFocus: boolean;
}): string {
  const fromTitle = HARNESS_TITLE[input.from];
  const sections = [
    `Give a read-only second opinion on work ${fromTitle} just finished in this same working copy. The files are already on disk.`,
    "Report what is wrong, what is missing, and what you would have done differently. Do not modify files, do not run formatters that write, and do not commit. If you would leave the work as-is, say so briefly.",
    `## User request\n${input.userRequest.trim() ? limitSection(input.userRequest, USER_LIMIT) : "(no user message on this turn)"}`,
    input.report.trim()
      ? `## What ${fromTitle} reported\n${limitSection(input.report, REPORT_LIMIT)}`
      : `## What ${fromTitle} reported\n(no written summary — inspect the files)`,
    input.files.length
      ? `## Files it edited\n${input.files.map((p) => `- ${p}`).join("\n")}`
      : "## Files it edited\n(none recorded on this turn)",
  ];
  if (input.role === "claude" && input.frontendFocus) {
    sections.push(
      "## Frontend focus\nPrioritize UI/UX, accessibility, layout, visual regressions, and component structure.",
    );
  }
  return limitSection(sections.join("\n\n"), PROMPT_LIMIT);
}

export function buildCursorMultiReviewRequest(input: {
  from: HarnessId;
  to: HarnessId;
  role: CursorMultiReviewRole;
  turn: Block[];
  cwd: string;
  pairId: string;
  sourceSessionId: string;
  turnId: string;
}) {
  const userRequest = turnUserRequest(input.turn);
  const files = turnEditedFiles(input.turn, input.cwd);
  const frontendFocus = pathsLookFrontend(files);
  return {
    prompt: buildCursorMultiReviewPrompt({
      from: input.from,
      to: input.to,
      role: input.role,
      userRequest,
      report: turnReport(input.turn),
      files,
      frontendFocus,
    }),
    options: {
      secondOpinion: {
        ...buildSecondOpinionCard({
          from: input.from,
          to: input.to,
          userRequest,
          files,
        }),
        kind: "cursor-multi-review" as const,
      } satisfies SecondOpinionMeta,
      // Callers attach pair metadata on the session or via submit options if available.
      cursorMultiReview: {
        sourceSessionId: input.sourceSessionId,
        turnId: input.turnId,
        pairId: input.pairId,
        role: input.role,
      },
    },
  };
}

export function shouldStartCursorMultiReview(input: {
  enabled: boolean;
  harness: HarnessId;
  turn: Block[];
  turnUserBlockId: string;
  hasInFlightPair: boolean;
  worktreeRemoved: boolean;
  isRemote: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.harness !== "cursor") return false;
  if (input.worktreeRemoved || input.isRemote) return false;
  if (input.hasInFlightPair) return false;
  const user = input.turn.find((b) => b.role === "user");
  if (!user || user.id !== input.turnUserBlockId) return false;
  if (user.appRequestId?.startsWith(CURSOR_MULTI_REVIEW_APP_PREFIX))
    return false;
  if (user.secondOpinion?.kind === "cursor-multi-review") return false;
  if (turnEditedFiles(input.turn).length === 0) return false;
  return true;
}
```

Keep `cursorMultiReview` on submit options as a TypeScript extension only if App can stash it; otherwise put `pairId`/`role` only in the pair tracker and use `secondOpinion.kind` on the user block for badges.

- [ ] **Step 5: Run tests — PASS**

```bash
npx vitest run src/features/sessions/model/cursorMultiReview.test.ts src/features/sessions/model/secondOpinion.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add \
  src/features/sessions/model/cursorMultiReview.ts \
  src/features/sessions/model/cursorMultiReview.test.ts \
  src/features/sessions/model/session.ts \
  src/features/sessions/data/sessionStore.ts
git commit -m "$(cat <<'EOF'
Add read-only Cursor multi-review prompts and trigger gates.

EOF
)"
```

---

### Task 4: Pair tracker + fan-in note builders

**Files:**
- Modify: `src/features/sessions/model/cursorMultiReview.ts`
- Modify: `src/features/sessions/model/cursorMultiReview.test.ts`

- [ ] **Step 1: Failing tests for pair settle + note text**

```ts
import {
  CursorMultiReviewPairs,
  buildCursorMultiReviewFanInText,
  buildCursorMultiReviewQueueMessage,
  truncateReviewReport,
} from "./cursorMultiReview";

describe("truncateReviewReport", () => {
  it("caps at 3000 characters", () => {
    expect(truncateReviewReport("x".repeat(4000)).length).toBe(3000);
  });
});

describe("CursorMultiReviewPairs", () => {
  it("fires onReady once when all children settle", () => {
    const ready: string[] = [];
    const pairs = new CursorMultiReviewPairs((pair) => {
      ready.push(pair.pairId);
    });
    const pairId = pairs.begin({
      sourceSessionId: "cursor-1",
      turnId: "u1",
      childSessionIds: ["r-claude", "r-codex"],
    });
    expect(pairs.hasInFlight("cursor-1", "u1")).toBe(true);
    pairs.settleChild("r-claude", {
      status: "completed",
      harness: "claude",
      title: "Review · Claude",
      text: "Looks fine.",
    });
    expect(ready).toEqual([]);
    pairs.settleChild("r-codex", {
      status: "failed",
      harness: "codex",
      title: "Review · Codex",
      text: "",
      error: "usage limited",
    });
    expect(ready).toEqual([pairId]);
    expect(pairs.hasInFlight("cursor-1", "u1")).toBe(false);
  });
});

describe("buildCursorMultiReviewFanInText", () => {
  it("includes both sections and read-only guidance", () => {
    const text = buildCursorMultiReviewFanInText([
      {
        status: "completed",
        harness: "claude",
        title: "Review · Claude",
        text: "Missing aria-label.",
      },
      {
        status: "completed",
        harness: "codex",
        title: "Review · Codex",
        text: "Off-by-one in the pager.",
      },
    ]);
    expect(text).toMatch(/read-only/i);
    expect(text).toContain("## Claude");
    expect(text).toContain("## Codex");
    expect(text).toContain("Missing aria-label");
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
npx vitest run src/features/sessions/model/cursorMultiReview.test.ts -t "CursorMultiReviewPairs|FanIn|truncate"
```

- [ ] **Step 3: Implement tracker**

```ts
import type { QueuedMessage } from "./session";

export type CursorMultiReviewChildResult = {
  status: "completed" | "failed" | "cancelled";
  harness: HarnessId;
  title: string;
  text: string;
  error?: string;
};

type Pair = {
  pairId: string;
  sourceSessionId: string;
  turnId: string;
  children: Map<
    string,
    { settled: boolean; result?: CursorMultiReviewChildResult }
  >;
};

export function truncateReviewReport(text: string): string {
  const trimmed = text.replace(/\r\n?/g, "\n").trim();
  return trimmed.length <= CHILD_REPORT_LIMIT
    ? trimmed
    : trimmed.slice(0, CHILD_REPORT_LIMIT);
}

export function buildCursorMultiReviewFanInText(
  results: CursorMultiReviewChildResult[],
): string {
  const parts = [
    "Multi-review of your last turn is ready (read-only).",
    "Consensus and disagreements below. Apply fixes you agree with; do not redo the whole task.",
  ];
  for (const result of results) {
    const title = HARNESS_TITLE[result.harness];
    const body =
      truncateReviewReport(result.text) ||
      (result.error
        ? `(${result.status}: ${result.error})`
        : `(${result.status}; no written report)`);
    parts.push(`## ${title}\n${body}`);
  }
  return parts.join("\n\n");
}

export function buildCursorMultiReviewQueueMessage(
  pairId: string,
  results: CursorMultiReviewChildResult[],
): QueuedMessage {
  return {
    id: `${CURSOR_MULTI_REVIEW_APP_PREFIX}${pairId}`,
    text: buildCursorMultiReviewFanInText(results),
    attachments: [],
  };
}

export class CursorMultiReviewPairs {
  private pairs = new Map<string, Pair>();
  private byChild = new Map<string, string>();

  constructor(private onReady: (pair: Pair & { results: CursorMultiReviewChildResult[] }) => void) {}

  begin(input: {
    sourceSessionId: string;
    turnId: string;
    childSessionIds: string[];
  }): string {
    const pairId = crypto.randomUUID();
    const children = new Map(
      input.childSessionIds.map((id) => [id, { settled: false }]),
    );
    const pair: Pair = {
      pairId,
      sourceSessionId: input.sourceSessionId,
      turnId: input.turnId,
      children,
    };
    this.pairs.set(pairId, pair);
    for (const id of input.childSessionIds) this.byChild.set(id, pairId);
    return pairId;
  }

  hasInFlight(sourceSessionId: string, turnId: string): boolean {
    for (const pair of this.pairs.values()) {
      if (
        pair.sourceSessionId === sourceSessionId &&
        pair.turnId === turnId &&
        [...pair.children.values()].some((c) => !c.settled)
      ) {
        return true;
      }
    }
    return false;
  }

  /** True if this session id is a registered review child. */
  isChild(sessionId: string): boolean {
    return this.byChild.has(sessionId);
  }

  settleChild(sessionId: string, result: CursorMultiReviewChildResult) {
    const pairId = this.byChild.get(sessionId);
    if (!pairId) return;
    const pair = this.pairs.get(pairId);
    if (!pair) return;
    const child = pair.children.get(sessionId);
    if (!child || child.settled) return;
    child.settled = true;
    child.result = result;
    if ([...pair.children.values()].some((c) => !c.settled)) return;
    const results = [...pair.children.values()].map((c) => c.result!);
    this.pairs.delete(pairId);
    for (const id of pair.children.keys()) this.byChild.delete(id);
    this.onReady({ ...pair, results });
  }

  /** Drop fan-in if the Cursor source was removed. */
  dropSource(sourceSessionId: string) {
    for (const [pairId, pair] of [...this.pairs]) {
      if (pair.sourceSessionId !== sourceSessionId) continue;
      this.pairs.delete(pairId);
      for (const id of pair.children.keys()) this.byChild.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run — PASS**

```bash
npx vitest run src/features/sessions/model/cursorMultiReview.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/features/sessions/model/cursorMultiReview.ts src/features/sessions/model/cursorMultiReview.test.ts
git commit -m "$(cat <<'EOF'
Add Cursor multi-review pair tracker and fan-in note builders.

EOF
)"
```

---

### Task 5: Settings UI toggle + Auto-review card label

**Files:**
- Modify: `src/features/settings/ui/SettingsView.tsx` (`ChatPage`, Code review group ~1253)
- Modify: `src/features/sessions/ui/SecondOpinionCard.tsx`
- Test: extend `SecondOpinionCard` coverage if a unit test file exists; otherwise add a small assertion in an existing transcript test, or skip UI test if none — prefer a tiny vitest on the card label via render if the repo already does that for SecondOpinionCard.

- [ ] **Step 1: Wire Settings toggle**

In `ChatPage`:

```ts
const [cursorMultiReview, setCursorMultiReview] = useState(
  loadCursorMultiReview,
);
const onCursorMultiReview = (next: boolean) => {
  saveCursorMultiReview(next);
  setCursorMultiReview(next);
};
```

Import `loadCursorMultiReview` / `saveCursorMultiReview`. Inside the Code review `Group`, add a Row **above** Diff view:

```tsx
<Row
  id="cursor-multi-review"
  label="Review Cursor turns with other models"
  description="After Cursor edits files, Claude and another provider review in parallel; a summary returns to Cursor. Reviewers report only and do not edit."
>
  <Toggle
    label="Review Cursor turns with other models"
    on={cursorMultiReview}
    onChange={onCursorMultiReview}
  />
</Row>
```

- [ ] **Step 2: Card label**

In `SecondOpinionCard.tsx`:

```tsx
{card.kind === "handoff"
  ? "Handoff"
  : card.kind === "cursor-multi-review"
    ? "Auto-review"
    : "Second opinion"}
```

- [ ] **Step 3: Smoke-check settings search still lists the new id** (optional quick test or manual).

- [ ] **Step 4: Commit**

```bash
git add \
  src/features/settings/ui/SettingsView.tsx \
  src/features/sessions/ui/SecondOpinionCard.tsx
git commit -m "$(cat <<'EOF'
Add Cursor multi-review settings toggle and Auto-review card label.

EOF
)"
```

---

### Task 6: `openSessionBeside` focus flag + launch helpers in App

**Files:**
- Modify: `src/app/App.tsx` (`openSessionBeside` ~10380, `onSecondOpinion` ~10420)

- [ ] **Step 1: Extend `openSessionBeside`**

Change signature to:

```ts
(
  sourceId: string,
  session: Session,
  cwd: string,
  focusComposer = false,
  focusNew = true,
) => { ... }
```

When applying tabs, set `focusedId: focusNew ? session.id : sourceId` (keep source focused when `focusNew` is false). Only update `activeTabId` when `focusNew` is true **or** the tab was not already active — if `focusNew` is false and the source tab is already active, do not steal focus to a new tab when falling back to `appendTab` (prefer splitting in place on the source tab).

Keep `onSecondOpinion` calling without the new arg (default `true`).

- [ ] **Step 2: Add `launchCursorMultiReview` callback**

Pseudocode to place near `onSecondOpinion`:

```ts
const cursorMultiReviewPairs = useRef(
  new CursorMultiReviewPairs((pair) => {
    const source = sessionsRef.current.find(
      (s) => s.id === pair.sourceSessionId,
    );
    if (!source || removingSessionIds.current.has(source.id)) return;
    const message = buildCursorMultiReviewQueueMessage(
      pair.pairId,
      pair.results,
    );
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== source.id) return session;
        if (
          session.queuedMessages?.some((m) => m.id === message.id) ||
          session.blocks.some((b) => b.appRequestId === message.id)
        ) {
          return session;
        }
        return {
          ...session,
          queuedMessages: [...(session.queuedMessages ?? []), message],
          queueStatus: session.queueStatus ?? "active",
        };
      }),
    );
  }),
);

const launchCursorMultiReview = useCallback(
  (sourceId: string, turn: Block[]) => {
    const source = sessionsRef.current.find((s) => s.id === sourceId);
    if (!source) return;
    const turnId = turn.find((b) => b.role === "user")?.id;
    if (!turnId) return;
    if (
      !shouldStartCursorMultiReview({
        enabled: loadCursorMultiReview(),
        harness: source.harness,
        turn,
        turnUserBlockId: turnId,
        hasInFlightPair: cursorMultiReviewPairs.current.hasInFlight(
          sourceId,
          turnId,
        ),
        worktreeRemoved: !!source.worktreeRemoved,
        isRemote: !!remoteProjectFor(source.cwd),
      })
    ) {
      return;
    }
    const reviewers = pickCursorMultiReviewers({
      isLive: (id) => isLiveHarness(id) && isHarnessAvailable(id),
      isVisible: (id) => isPickerProviderVisible(id),
      usedPercent: (id) => harnessUsedPercent(id, source.cwd),
    });
    if (reviewers.length === 0) return;

    const cwd = sessionWorkCwd(source);
    const from = harnessForTurn(source.blocks, turn, source.harness);
    const childIds: string[] = [];
    const pending: { session: Session; reviewer: CursorMultiReviewer }[] = [];

    for (const reviewer of reviewers) {
      const session = {
        ...newSession(
          reviewer.harness,
          source.cwd,
          preferredModelId(reviewer.harness),
          reviewer.harness === "codex" ? "full-access" : source.runtimeMode,
        ),
        worktreeCwd: source.worktreeCwd,
        branch: source.branch,
        title: formatSessionTitle(
          reviewer.harness,
          `${CURSOR_MULTI_REVIEW_TITLE_PREFIX}${HARNESS_TITLE[reviewer.harness]}`,
        ),
      };
      childIds.push(session.id);
      pending.push({ session, reviewer });
    }

    const pairId = cursorMultiReviewPairs.current.begin({
      sourceSessionId: sourceId,
      turnId,
      childSessionIds: childIds,
    });

    for (const { session, reviewer } of pending) {
      openSessionBeside(sourceId, session, source.cwd, false, false);
      const request = buildCursorMultiReviewRequest({
        from,
        to: reviewer.harness,
        role: reviewer.role,
        turn,
        cwd,
        pairId,
        sourceSessionId: sourceId,
        turnId,
      });
      onSubmit(session.id, request.prompt, [], request.options);
    }
  },
  [onSubmit, openSessionBeside],
);
```

Wire imports: `loadCursorMultiReview`, `pickCursorMultiReviewers`, `shouldStartCursorMultiReview`, `buildCursorMultiReviewRequest`, `CursorMultiReviewPairs`, `buildCursorMultiReviewQueueMessage`, `CURSOR_MULTI_REVIEW_TITLE_PREFIX`, `harnessUsedPercent`, `isHarnessAvailable`, `isPickerProviderVisible`, `preferredModelId`, `remoteProjectFor`, `groupTurns` / latest turn extraction.

- [ ] **Step 3: Commit**

```bash
git add src/app/App.tsx
git commit -m "$(cat <<'EOF'
Launch Cursor multi-review sessions without stealing focus.

EOF
)"
```

---

### Task 7: Trigger on Cursor turn settle + settle review children

**Files:**
- Modify: `src/app/App.tsx` (submitSession success path ~9025; `options?.onSettled` / finally ~9066)

- [ ] **Step 1: After a turn finishes successfully (and on stop-with-edits), maybe launch**

In the turn-complete path where `notifyReviewChanged(sessionId)` runs (~9025), after sessions are updated and idle:

```ts
window.setTimeout(() => {
  const finished = sessionsRef.current.find((s) => s.id === sessionId);
  if (!finished || finished.busy) return;

  // Review child settled → fan-in.
  if (cursorMultiReviewPairs.current.isChild(sessionId)) {
    const turns = groupTurns(finished.blocks);
    const last = turns[turns.length - 1] ?? [];
    const report =
      [...last].reverse().find(
        (b) => b.role === "assistant" && !b.tool && b.text.trim(),
      )?.text ?? "";
    cursorMultiReviewPairs.current.settleChild(sessionId, {
      status: controlOutcome.status === "cancelled"
        ? "cancelled"
        : controlOutcome.status === "failed"
          ? "failed"
          : "completed",
      harness: finished.harness,
      title: finished.title,
      text: report,
      error: controlOutcome.error,
    });
    return;
  }

  if (finished.harness !== "cursor") return;
  const turns = groupTurns(finished.blocks);
  const turn = turns[turns.length - 1];
  if (turn) launchCursorMultiReviewRef.current?.(finished.id, turn);
}, 0);
```

Keep a `launchCursorMultiReviewRef` updated each render like other App refs.

Use the same `controlOutcome` already computed in that closure. Ensure cancelled/failed child reviews still call `settleChild`.

Also call `cursorMultiReviewPairs.current.dropSource(sessionId)` when a Cursor session is deleted/removed (find `removeSession` / archive delete path).

- [ ] **Step 2: Confirm queue drain delivers fan-in**

Existing `useEffect` that dispatches `queuedMessages` when `canDispatchQueuedHead` must pick up the fan-in message. Verify `onSubmit` from queue sets `appRequestId` from `message.id` (already true for Mono completions / queued sends — confirm the queue submit path passes `appRequestId: head.id`; if not, extend that path for ids starting with `CURSOR_MULTI_REVIEW_APP_PREFIX`).

- [ ] **Step 3: Manual reasoning check / small App-level unit if feasible**

Prefer extracting “latest turn from session blocks” into `cursorMultiReview.ts` as `latestUserTurn(blocks): Block[] | null` tested in unit tests so App stays thin.

- [ ] **Step 4: Commit**

```bash
git add src/app/App.tsx src/features/sessions/model/cursorMultiReview.ts src/features/sessions/model/cursorMultiReview.test.ts
git commit -m "$(cat <<'EOF'
Trigger Cursor multi-review on turn settle and fan in results.

EOF
)"
```

---

### Task 8: Verification gate

- [ ] **Step 1: Unit suite**

```bash
npx vitest run \
  src/features/sessions/model/cursorMultiReview.test.ts \
  src/features/sessions/model/secondOpinion.test.ts \
  src/features/settings/model/settings.test.ts \
  src/fork/continueElsewhere/continueUsage.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Spec coverage checklist (read-only)**

Confirm each spec requirement has code:

| Spec item | Task |
|-----------|------|
| Every Cursor editing turn triggers | Task 7 |
| Claude + usage-aware peer | Task 2 |
| Read-only prompts | Task 3 |
| Parallel sessions + no focus steal | Task 6 |
| Combined note into Cursor via queue | Task 4 + 7 |
| Frontend Claude focus | Task 3 |
| Settings default on | Task 1 + 5 |
| Loop skip for fan-in | Task 3 |
| Remote skip v1 | Task 6 gate |
| Second opinion unchanged | no edits to may-fix prompt |

- [ ] **Step 4: Final commit if any fixes**

```bash
git status -sb
# commit only if verification fixed files
```

---

## Self-review (plan author)

1. **Spec coverage:** Trigger, pick, read-only, parallel launch, fan-in queue, settings, frontend Claude bias, edges (remote skip, pair drop, child failure) each map to a task.
2. **Placeholders:** None intentional; App wiring uses concrete helper names from Tasks 2–4.
3. **Types:** `SecondOpinionMeta.kind` includes `"cursor-multi-review"`; queue message id uses `CURSOR_MULTI_REVIEW_APP_PREFIX`; pair tracker `onReady` receives `results`.
