import { limitSection } from "../../../shared/lib/jsonText";
import {
  HARNESSES,
  HARNESS_TITLE,
  type Block,
  type HarnessId,
  type QueuedMessage,
  type SecondOpinionMeta,
} from "./session";
import {
  buildSecondOpinionCard,
  turnEditedFiles,
  turnReport,
  turnUserRequest,
} from "./secondOpinion";
import { groupTurns } from "./transcriptActivity";

const FRONTEND_EXT =
  /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
const FRONTEND_SEG = /(?:^|\/)(?:components|ui|styles)(?:\/|$)/i;
const PEER_FALLBACK: HarnessId[] = ["codex", "grok"];

export const CURSOR_MULTI_REVIEW_APP_PREFIX = "cursor-multi-review-";
export const CURSOR_MULTI_REVIEW_TITLE_PREFIX = "Review · ";
const USER_LIMIT = 400;
const REPORT_LIMIT = 900;
const PROMPT_LIMIT = 1_800;
export const CHILD_REPORT_LIMIT = 3_000;

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
    "Report what is wrong, what is missing, and what you would have done differently. Do not modify files, do not run formatters that write, and do not commit. Read the files directly where you can, because commands may need approval. If you would leave the work as-is, say so briefly.",
    // Ahead of the file list, which can run past the prompt limit.
    ...(input.role === "claude" && input.frontendFocus
      ? [
          "## Frontend focus\nPrioritize UI/UX, accessibility, layout, visual regressions, and component structure.",
        ]
      : []),
    `## User request\n${input.userRequest.trim() ? limitSection(input.userRequest, USER_LIMIT) : "(no user message on this turn)"}`,
    input.report.trim()
      ? `## What ${fromTitle} reported\n${limitSection(input.report, REPORT_LIMIT)}`
      : `## What ${fromTitle} reported\n(no written summary — inspect the files)`,
    input.files.length
      ? `## Files it edited\n${input.files.map((p) => `- ${p}`).join("\n")}`
      : "## Files it edited\n(none recorded on this turn)",
  ];
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

/** Latest turn from transcript blocks, or null when empty. */
export function latestUserTurn(blocks: Block[]): Block[] | null {
  const turns = groupTurns(blocks);
  return turns[turns.length - 1] ?? null;
}

export function shouldStartCursorMultiReview(input: {
  enabled: boolean;
  harness: HarnessId;
  turn: Block[];
  turnUserBlockId: string;
  alreadyReviewed: boolean;
  worktreeRemoved: boolean;
  isRemote: boolean;
  backgroundRun: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.harness !== "cursor") return false;
  if (input.worktreeRemoved || input.isRemote || input.backgroundRun) {
    return false;
  }
  if (input.alreadyReviewed) return false;
  const user = input.turn.find((b) => b.role === "user");
  if (!user || user.id !== input.turnUserBlockId) return false;
  if (user.appRequestId?.startsWith(CURSOR_MULTI_REVIEW_APP_PREFIX))
    return false;
  if (user.secondOpinion?.kind === "cursor-multi-review") return false;
  if (turnEditedFiles(input.turn).length === 0) return false;
  return true;
}

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

/** What one finished reviewer sends back: its last written reply. */
export function cursorMultiReviewChildResult(
  child: { harness: HarnessId; title: string; blocks: Block[] },
  outcome: { status: string; error?: string },
): CursorMultiReviewChildResult {
  const turn = latestUserTurn(child.blocks) ?? [];
  const reply = [...turn]
    .reverse()
    .find((b) => b.role === "assistant" && !b.tool && b.text.trim());
  return {
    status:
      outcome.status === "cancelled" || outcome.status === "failed"
        ? outcome.status
        : "completed",
    harness: child.harness,
    title: child.title,
    text: reply?.text ?? "",
    error: outcome.error,
  };
}

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
    const report = truncateReviewReport(result.text);
    // A reviewer that stopped early must not read as a finished review.
    const status =
      result.status === "completed"
        ? ""
        : result.error
          ? `(${result.status}: ${result.error})`
          : `(${result.status})`;
    const body =
      [status, report].filter(Boolean).join("\n") ||
      "(completed; no written report)";
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

function startedKey(sourceSessionId: string, turnId: string): string {
  return `${sourceSessionId}\u0000${turnId}`;
}

export class CursorMultiReviewPairs {
  private pairs = new Map<string, Pair>();
  private byChild = new Map<string, string>();
  /** Turns already reviewed, so a later settle of the same turn can't re-fire. */
  private started = new Set<string>();

  constructor(
    private onReady: (
      pair: Pair & { results: CursorMultiReviewChildResult[] },
    ) => void,
  ) {}

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
    this.started.add(startedKey(input.sourceSessionId, input.turnId));
    for (const id of input.childSessionIds) this.byChild.set(id, pairId);
    return pairId;
  }

  hasStarted(sourceSessionId: string, turnId: string): boolean {
    return this.started.has(startedKey(sourceSessionId, turnId));
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

export { HARNESS_TITLE };
