import {
  firstClassProviders,
  supportsFirstClassHandoff,
} from "../../integrations/harness/core/firstClassProviders";
import type { HarnessId } from "../../features/sessions/model/session";
import { HARNESS_TITLE } from "../../features/sessions/model/session";

/**
 * Fork feature: when one provider runs out of quota, carry the session over to
 * another with a trimmed brief. The brief comes from upstream's handoff; this
 * adds the way there, the way back to the full transcript, and a visible origin.
 *
 * First-class handoff peers (Claude, Codex, Grok) plus Cursor can continue into
 * each other. When usage is known, the default pick is the live candidate with
 * the most headroom; otherwise preferred pairings apply.
 */
const ORIGINS_KEY = "monocode.fork.continuedFrom";
const MAX_ORIGINS = 200;

/** Extra continue peers that aren't first-class profiles yet. */
const EXTRA_CONTINUE_PEERS = ["cursor"] as const satisfies readonly HarnessId[];

/** Providers that can hand a limited session to each other. */
export const CONTINUE_POOL: readonly HarnessId[] = [
  ...new Set<HarnessId>([
    ...firstClassProviders().filter(supportsFirstClassHandoff),
    ...EXTRA_CONTINUE_PEERS,
  ]),
];

/** Preferred fallback when usage is unknown. */
const PREFERRED: Partial<Record<HarnessId, HarnessId>> = {
  claude: "codex",
  codex: "claude",
  grok: "claude",
  cursor: "claude",
};

export function handoffTargets(harness: HarnessId): HarnessId[] {
  if (!CONTINUE_POOL.includes(harness)) return [];
  return CONTINUE_POOL.filter((id) => id !== harness);
}

export type ContinuePickOptions = {
  /** Defaults to every candidate (tests and menus without live state). */
  isLive?: (id: HarnessId) => boolean;
  /** Used percent 0–100; lower means more headroom. Unknown entries are skipped. */
  usedPercent?: (id: HarnessId) => number | null;
};

export function continueTarget(
  harness: HarnessId,
  options: ContinuePickOptions = {},
): HarnessId | null {
  const candidates = handoffTargets(harness);
  if (candidates.length === 0) return null;
  const live = options.isLive
    ? candidates.filter((id) => options.isLive!(id))
    : candidates;
  if (live.length === 0) return null;
  if (live.length === 1) return live[0]!;

  const usedOf = options.usedPercent;
  if (usedOf) {
    let best: HarnessId | null = null;
    let bestUsed = Number.POSITIVE_INFINITY;
    for (const id of live) {
      const used = usedOf(id);
      if (used == null || !Number.isFinite(used)) continue;
      if (used < bestUsed) {
        bestUsed = used;
        best = id;
      }
    }
    if (best) return best;
  }

  const preferred = PREFERRED[harness];
  if (preferred && live.includes(preferred)) return preferred;
  return live[0]!;
}

export function continueLabel(
  harness: HarnessId,
  options: ContinuePickOptions = {},
): string | null {
  const target = continueTarget(harness, options);
  return target ? `Continue in ${HARNESS_TITLE[target]}` : null;
}

export function continueLabelFor(
  _harness: HarnessId,
  target: HarnessId,
): string {
  return `Continue in ${HARNESS_TITLE[target]}`;
}

/** The brief is trimmed on purpose, so it says where the rest lives. */
export function withTranscriptPointer(brief: string, sessionId: string): string {
  const pointer = `## Full transcript
This brief is trimmed. The whole conversation is MonoCode session ${sessionId}. MonoCode supplies a local conversation archive when continuing; read that archive for the original instructions.`;
  return brief.trim() ? `${brief.trim()}\n\n${pointer}` : pointer;
}

export type ContinuedOrigin = {
  sessionId: string;
  throughBlockId?: string;
  from: HarnessId;
  to: HarnessId;
  title: string;
  files: number;
};

type Origins = Record<string, ContinuedOrigin>;

function readOrigins(): Origins {
  try {
    const parsed = JSON.parse(localStorage.getItem(ORIGINS_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Origins) : {};
  } catch {
    return {};
  }
}

export function saveContinuedOrigin(sessionId: string, origin: ContinuedOrigin) {
  try {
    const entries = Object.entries(readOrigins()).filter(([id]) => id !== sessionId);
    entries.push([sessionId, origin]);
    localStorage.setItem(
      ORIGINS_KEY,
      JSON.stringify(Object.fromEntries(entries.slice(-MAX_ORIGINS))),
    );
  } catch {
    // The card is a nicety; the handoff itself doesn't depend on it.
  }
}

export function continuedOrigin(sessionId: string): ContinuedOrigin | null {
  const origin = readOrigins()[sessionId];
  return origin && typeof origin.sessionId === "string" ? origin : null;
}

export type ContinueHost = {
  canContinue: (sessionId: string) => boolean;
  /** `target` required when multiple peers exist; omit only for primary default. */
  continueSession: (sessionId: string, target?: HarnessId) => void;
  openSession: (sessionId: string) => void;
  /** Live handoff peers for a session (installed/live filtered by the host). */
  targetsFor?: (sessionId: string) => HarnessId[];
};

let host: ContinueHost | null = null;

export function registerContinueHost(next: ContinueHost | null) {
  host = next;
}

export const continueHost = () => host;
