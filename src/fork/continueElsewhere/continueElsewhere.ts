import type { HarnessId } from "../../features/sessions/model/session";
import { HARNESS_TITLE } from "../../features/sessions/model/session";

/**
 * Fork feature: when one provider runs out of quota, carry the session over to
 * the other with a trimmed brief. The brief comes from upstream's handoff; this
 * adds the way there, the way back to the full transcript, and a visible origin.
 */
const ORIGINS_KEY = "monocode.fork.continuedFrom";
const MAX_ORIGINS = 200;

const OTHER: Partial<Record<HarnessId, HarnessId>> = {
  claude: "codex",
  codex: "claude",
};

export function continueTarget(harness: HarnessId): HarnessId | null {
  return OTHER[harness] ?? null;
}

export function continueLabel(harness: HarnessId): string | null {
  const target = continueTarget(harness);
  return target ? `Continue in ${HARNESS_TITLE[target]}` : null;
}

/** The brief is trimmed on purpose, so it says where the rest lives. */
export function withTranscriptPointer(brief: string, sessionId: string): string {
  const pointer = `## Full transcript
This brief is trimmed. The whole conversation is MonoCode session ${sessionId}. If you need detail that isn't here, ask the user to send /operator, then read it with the app CLI: sessions.read {"sessionId":"${sessionId}"}.`;
  return brief.trim() ? `${brief.trim()}\n\n${pointer}` : pointer;
}

export type ContinuedOrigin = {
  sessionId: string;
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
  continueSession: (sessionId: string) => void;
  openSession: (sessionId: string) => void;
};

let host: ContinueHost | null = null;

export function registerContinueHost(next: ContinueHost | null) {
  host = next;
}

export const continueHost = () => host;
