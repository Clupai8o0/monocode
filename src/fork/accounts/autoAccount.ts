/**
 * Fork feature: "Auto" as a per-project Claude account choice. Each new
 * session starts on the account with the most headroom; a running session
 * never moves on its own. This file is pure so the pick is easy to test.
 */

/** Stored in place of an account id when a project's choice is Auto. */
export const AUTO_ACCOUNT_ID = "auto";

/** Same tones as accountUsage's AccountStatusTone. */
export type AutoTone = "ready" | "low" | "checking" | "unknown" | "exhausted";

/**
 * `headroom` is the remaining % (accountHeadroom) the tone was derived from,
 * absent while usage is unknown.
 */
export type AutoCandidate = { id: string; tone: AutoTone; headroom?: number };

const RANK: Record<AutoTone, number> = {
  ready: 0,
  low: 1,
  checking: 2,
  unknown: 2,
  exhausted: 3,
};

/** Only Claude has two logins on this Mac worth choosing between. */
export function supportsAutoAccount(provider: string): boolean {
  return provider === "claude";
}

/**
 * The account a new session should start on: ready before low before
 * not-yet-known, exhausted only when every account is. Within one tone the
 * account with more headroom wins; ties go to main, then to the first account
 * in the list. Null only for an empty list.
 */
export function pickAutoAccount(
  candidates: AutoCandidate[],
  mainId: string,
): string | null {
  let best: AutoCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || beats(candidate, best, mainId)) {
      best = candidate;
    }
  }
  return best?.id ?? null;
}

function beats(
  candidate: AutoCandidate,
  best: AutoCandidate,
  mainId: string,
): boolean {
  if (RANK[candidate.tone] !== RANK[best.tone]) {
    return RANK[candidate.tone] < RANK[best.tone];
  }
  if (
    candidate.headroom !== undefined &&
    best.headroom !== undefined &&
    candidate.headroom !== best.headroom
  ) {
    return candidate.headroom > best.headroom;
  }
  return candidate.id === mainId;
}

/**
 * The account to suggest when this session's account is exhausted: the
 * best other account, if it has any headroom (ready or low).
 */
export function exhaustedSwitchTarget(
  currentId: string,
  candidates: AutoCandidate[],
  mainId: string,
): string | null {
  const others = candidates.filter(
    (candidate) =>
      candidate.id !== currentId &&
      (candidate.tone === "ready" || candidate.tone === "low"),
  );
  return pickAutoAccount(others, mainId);
}
