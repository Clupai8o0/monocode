import { limitSection } from "../../../shared/lib/jsonText";
import {
  HARNESSES,
  HARNESS_TITLE,
  type Block,
  type HarnessId,
  type SecondOpinionMeta,
} from "./session";
import {
  buildSecondOpinionCard,
  turnEditedFiles,
  turnReport,
  turnUserRequest,
} from "./secondOpinion";

const FRONTEND_EXT =
  /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
const FRONTEND_SEG = /(?:^|\/)(?:components|ui|styles)(?:\/|$)/i;
const PEER_FALLBACK: HarnessId[] = ["codex", "grok"];

export const CURSOR_MULTI_REVIEW_APP_PREFIX = "cursor-multi-review-";
export const CURSOR_MULTI_REVIEW_TITLE_PREFIX = "Review · ";
const USER_LIMIT = 400;
const REPORT_LIMIT = 900;
const PROMPT_LIMIT = 1_800;
/** Reserved for Task 4 fan-in child report truncation. */
const CHILD_REPORT_LIMIT = 3_000;

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

export { CHILD_REPORT_LIMIT, HARNESS_TITLE };
