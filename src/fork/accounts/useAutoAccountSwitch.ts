import { useEffect, useRef, useState } from "react";
import {
  accountHeadroom,
  accountStatus,
} from "../../features/providers/model/accountUsage";
import {
  DEFAULT_PROVIDER_ACCOUNT_ID,
  providerAccounts,
} from "../../features/providers/model/providerAccounts";
import { loadRateLimits } from "../../features/providers/model/rateLimitsCache";
import { getComposerDraft } from "../../features/sessions/model/draftCache";
import {
  sessionNeedsInput,
  sessionDraftBlock,
  type Session,
} from "../../features/sessions/model/session";
import { exhaustedSwitchTarget, supportsAutoAccount } from "./autoAccount";

function eligible(session: Session): boolean {
  return (
    supportsAutoAccount(session.harness) &&
    !!session.usageLimit &&
    !session.usageLimit.recoveryFailed &&
    !session.busy &&
    !session.ephemeral &&
    !session.orchestrationLeadId &&
    !session.worktreeRemoved &&
    !session.worktreePreparing &&
    !session.cwd.startsWith("remote://") &&
    !sessionNeedsInput(session) &&
    !sessionDraftBlock(session) &&
    !getComposerDraft(session.id)?.trim()
  );
}

/** Continue a confirmed usage-limit failure through the existing transcript transfer.
 * Never move a running turn or infer a failure from the usage meter alone. */
export function useAutoAccountSwitch(
  sessions: Session[],
  readSessions: () => Session[],
  move: (id: string, accountId: string) => Promise<void>,
  connected: (session: Session) => boolean,
  revision: (id: string) => number = () => 0,
): void {
  const latest = useRef({ readSessions, move, connected, revision });
  latest.current = { readSessions, move, connected, revision };
  const mounted = useRef(true);
  const inflight = useRef(new Set<string>());
  const attempted = useRef(new Map<string, string>());
  // A provider's actual refusal overrides even a fresh but lagging usage meter.
  const exhausted = useRef(new Map<string, number>());
  const failures = useRef(new Map<string, { source: string; until: number }>());
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const live = new Set(sessions.map((session) => session.id));
    for (const id of attempted.current.keys()) {
      if (!live.has(id)) {
        attempted.current.delete(id);
        failures.current.delete(id);
      }
    }
    for (const session of sessions) {
      if (!session.usageLimit) {
        failures.current.delete(session.id);
        if (!session.busy && !inflight.current.has(session.id)) {
          attempted.current.delete(session.id);
        }
        continue;
      }
      if (
        session.usageLimit.recoveryFailed ||
        session.cwd.startsWith("remote://") ||
        !latest.current.connected(session)
      ) {
        continue;
      }
      const provider = session.harness;
      if (provider !== "claude" && provider !== "codex") {
        continue;
      }
      const accountId =
        session.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID;
      const source = `${provider}:${accountId}`;
      const now = Date.now();
      const remembered = exhausted.current.get(source);
      let failure = failures.current.get(session.id);
      if (failure?.source !== source) {
        failure = {
          source,
          until: Math.max(
            now + 60_000,
            session.usageLimit.resetsAt ?? now + 300_000,
          ),
        };
        failures.current.set(session.id, failure);
      }
      exhausted.current.set(
        source,
        Math.max(
          remembered ?? 0,
          failure.until,
          session.usageLimit.resetsAt ?? 0,
        ),
      );
      if (
        !eligible(session) ||
        !latest.current.connected(session) ||
        inflight.current.has(session.id)
      ) {
        continue;
      }
      if (attempted.current.get(session.id) === source) {
        continue;
      }
      attempted.current.set(session.id, source);
      const others = providerAccounts(provider).filter(
        (account) =>
          account.id !== accountId &&
          (exhausted.current.get(`${provider}:${account.id}`) ?? 0) <= now,
      );
      if (!others.length) {
        continue;
      }
      inflight.current.add(session.id);
      const version = latest.current.revision(session.id);
      void (async () => {
        try {
          const candidates = await Promise.all(
            others.map(async (account) => {
              const limits = await loadRateLimits(provider, account.id, true);
              const time = Date.now();
              return {
                id: account.id,
                tone:
                  limits.status === "ok"
                    ? accountStatus(limits, time).tone
                    : ("unknown" as const),
                headroom: accountHeadroom(limits, time) ?? undefined,
              };
            }),
          );
          const current = latest.current
            .readSessions()
            .find((entry) => entry.id === session.id);
          // A workspace move or pending question can temporarily suspend the
          // attempt. Stop changes the revision and deliberately cancels it.
          if (
            mounted.current &&
            current &&
            current.usageLimit &&
            current.harness === provider &&
            (current.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID) ===
              accountId &&
            latest.current.revision(session.id) === version &&
            (!eligible(current) || !latest.current.connected(current))
          ) {
            attempted.current.delete(session.id);
            setRetryTick((tick) => tick + 1);
          }
          if (
            !mounted.current ||
            !current ||
            !eligible(current) ||
            !latest.current.connected(current) ||
            latest.current.revision(session.id) !== version ||
            current.harness !== provider ||
            current.providerSessionId !== session.providerSessionId ||
            (current.providerAccountId ?? DEFAULT_PROVIDER_ACCOUNT_ID) !==
              accountId
          ) {
            return;
          }
          const target = exhaustedSwitchTarget(
            accountId,
            candidates.filter(
              (candidate) =>
                providerAccounts(provider).some(
                  (account) => account.id === candidate.id,
                ) &&
                (exhausted.current.get(`${provider}:${candidate.id}`) ?? 0) <=
                  Date.now(),
            ),
            DEFAULT_PROVIDER_ACCOUNT_ID,
          );
          if (target) {
            await latest.current.move(session.id, target);
          }
        } catch (error) {
          // The existing paused notice remains available for a manual retry.
          console.warn("Automatic account switch could not continue", error);
        } finally {
          inflight.current.delete(session.id);
        }
      })();
    }
  }, [sessions, retryTick]);
}
