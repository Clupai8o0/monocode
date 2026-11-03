import { handoffTargets as profileHandoffTargets } from "../../integrations/harness/core/firstClassProviders";
import type { HarnessId } from "../../features/sessions/model/session";
import { HARNESS_TITLE } from "../../features/sessions/model/session";

/**
 * Fork feature: when one provider runs out of quota, carry the session over to
 * the other with a trimmed brief. The brief comes from upstream's handoff; this
 * adds the way there, the way back to the full transcript, and a visible origin.
 */
const ORIGINS_KEY = "monocode.fork.continuedFrom";
const MAX_ORIGINS = 200;

export function handoffTargets(harness: HarnessId): HarnessId[] {
  return profileHandoffTargets(harness);
}

/** Preferred single target when the UI has not picked one yet. */
const PRIMARY: Partial<Record<HarnessId, HarnessId>> = {
  claude: "codex",
  codex: "claude",
  grok: "claude",
};

export function continueTarget(harness: HarnessId): HarnessId | null {
  const targets = handoffTargets(harness);
  if (targets.length === 0) return null;
  const preferred = PRIMARY[harness];
  return preferred && targets.includes(preferred) ? preferred : targets[0];
}

export function continueLabel(harness: HarnessId): string | null {
  const target = continueTarget(harness);
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
