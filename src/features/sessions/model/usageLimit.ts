import { formatResetDuration } from "../../providers/model/rateLimits";
import { sameProviderAccountId } from "../../providers/model/providerAccounts";
import type { Session, UsageLimit } from "./session";

/** A fallback for adapters that report exhausted accounts as plain errors. */
export function usageLimitFromError(message: string): UsageLimit | undefined {
  return /(?:usage|spending|monthly|weekly|daily) limit (?:reached|exceeded)|(?:quota|credits?) (?:exceeded|exhausted|depleted)|insufficient[_ ](?:quota|credits)|hit your (?:usage )?limit|credit balance is too low/i.test(
    message,
  )
    ? {}
    : undefined;
}

/** Release the stopped outbox only when the user chooses to recover. */
export function resumeUsageLimitedSession(session: Session): Session {
  if (!session.usageLimit || session.busy) return session;
  return {
    ...session,
    usageLimit: undefined,
    queueStatus: session.queuedMessages?.length ? "active" : undefined,
    queuedMessages: session.queuedMessages?.map((message) => ({
      ...message,
      error: undefined,
    })),
  };
}

/**
 * Point a usage-limited session at another account of its provider. When its
 * native transcript was carried to that account, the same provider session
 * resumes there. Otherwise the next turn starts a new provider thread from a
 * handoff brief; the limited account cannot be asked for a recap.
 */
export function withUsageLimitAccount(
  session: Session,
  accountId: string,
  carried: boolean,
): Session {
  if (carried) return { ...session, providerAccountId: accountId };
  return {
    ...session,
    providerAccountId: accountId,
    providerSessionId: undefined,
    pendingSwitch: {
      ...(session.pendingSwitch ?? {
        from: session.harness,
        fromModel: session.model,
        fromSettings: session.modelSettings,
        fromProviderSessionId: session.providerSessionId,
        fromProviderAccountId: session.providerAccountId,
      }),
      skipOutgoingRecap: true,
    },
  };
}

/**
 * What picking another account does to the open session. A conversation
 * that is not mid-turn moves there and carries on (`move`); an empty one just
 * takes the account (`assign`). A running turn, or a Mono that is not
 * limited, keeps its account while a fresh session opens on the pick (`open`).
 */
export function accountPickAction(
  session: Session,
  accountId: string,
  mono: boolean,
): "move" | "assign" | "open" | "none" {
  if (session.usageLimit && !session.busy) return "move";
  if (session.blocks.length === 0 && !session.busy) {
    return session.providerAccountId === accountId ? "none" : "assign";
  }
  if (sameProviderAccountId(session.providerAccountId, accountId)) {
    return "none";
  }
  return session.busy || mono ? "open" : "move";
}

/** Providers can still refuse right at the reset; give them a moment. */
export const USAGE_LIMIT_RESUME_GRACE_MS = 30_000;

/** "3:16 AM · in 4h 42m" today, "Sep 26, 3:16 AM · in 1d 4h" later. */
export function formatUsageLimitReset(resetsAt: number, now: number): string {
  const reset = new Date(resetsAt);
  const sameDay = reset.toDateString() === new Date(now).toDateString();
  const when = reset.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
  return `${when} · in ${formatResetDuration(resetsAt - now)}`;
}

/** Idle, armed, and past its reset: time to send the continue turn. */
export function usageLimitResumeDue(session: Session, now: number): boolean {
  const limit = session.usageLimit;
  if (!limit?.resumeAtReset || limit.resetsAt == null || session.busy) {
    return false;
  }
  return now >= limit.resetsAt + USAGE_LIMIT_RESUME_GRACE_MS;
}
