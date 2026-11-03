import { useEffect, useRef } from "react";
import { isMonoSession } from "../../features/monos/model/mono";
import { isPreparingHandoff } from "../../features/sessions/model/handoff";
import { getComposerDraft } from "../../features/sessions/model/draftCache";
import {
  sessionDraftBlock,
  sessionNeedsInput,
  type Session,
} from "../../features/sessions/model/session";

export const AUTO_HANDOFF_PROMPT =
  "Continue where we left off. Carry out the remaining work using the handoff context; if the task is complete, say so briefly.";

type Submit = (
  id: string,
  text: string,
  attachments: never[],
  options: { intent?: "plan" | "orchestrate" },
) => unknown;

function requestOf(session: Session): string | undefined {
  return (
    session.pendingSwitch?.autoContinue ?? session.handoffCard?.autoContinue
  );
}

function lastTurnIntent(
  blocks: Session["blocks"],
): "plan" | "orchestrate" | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role !== "user" || block.draft) continue;
    return block.intent === "plan" || block.intent === "orchestrate"
      ? block.intent
      : undefined;
  }
  return undefined;
}

function canContinue(
  session: Session,
  connected: (session: Session) => boolean,
): boolean {
  return (
    !session.busy &&
    !session.ephemeral &&
    !session.orchestrationLeadId &&
    !isMonoSession(session.id) &&
    !session.worktreePreparing &&
    !session.worktreeRemoved &&
    !session.usageLimit &&
    !session.queuedMessages?.length &&
    !sessionDraftBlock(session) &&
    !getComposerDraft(session.id)?.trim() &&
    !sessionNeedsInput(session) &&
    !isPreparingHandoff(session) &&
    connected(session)
  );
}

/** A picker switch and a Continue action each carry on once, after state commits. */
export function useAutoHandoff(
  sessions: Session[],
  submit: { current: Submit },
  connected: (session: Session) => boolean,
) {
  const attempted = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latest = useRef({ sessions, connected });
  latest.current = { sessions, connected };
  useEffect(() => {
    const liveRequests = new Set<string>();
    const runnable = new Set<string>();
    for (const session of sessions) {
      const request = requestOf(session);
      if (!request) {
        continue;
      }
      liveRequests.add(request);
      if (attempted.current.has(request) || !canContinue(session, connected)) {
        continue;
      }
      runnable.add(request);
      if (timers.current.has(request)) {
        continue;
      }
      // Give rapid picker changes a chance to settle before launching a provider.
      timers.current.set(
        request,
        setTimeout(() => {
          timers.current.delete(request);
          const now = latest.current.sessions.find(
            (item) => item.id === session.id,
          );
          if (
            !now ||
            requestOf(now) !== request ||
            !canContinue(now, latest.current.connected)
          ) {
            return;
          }
          attempted.current.add(request);
          const intent = now.handoffCard?.intent ?? lastTurnIntent(now.blocks);
          void Promise.resolve(
            submit.current(now.id, AUTO_HANDOFF_PROMPT, [], { intent }),
          ).catch(() => undefined);
        }, 150),
      );
    }
    for (const [request, timer] of timers.current) {
      if (!runnable.has(request)) {
        clearTimeout(timer);
        timers.current.delete(request);
      }
    }
    for (const request of attempted.current) {
      if (!liveRequests.has(request)) {
        attempted.current.delete(request);
      }
    }
  }, [sessions, submit, connected]);
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) {
        clearTimeout(timer);
      }
      timers.current.clear();
    },
    [],
  );
}
