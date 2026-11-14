import { sameProjectPath } from "../../features/projects/model/recents";
import {
  appendReadyHandoff,
  completeHandoff,
  consumeHandoff,
  isPreparingHandoff,
} from "../../features/sessions/model/handoff";
import { operatorUserPrompt } from "../../features/sessions/model/operatorCommand";
import type { HarnessId, Session } from "../../features/sessions/model/session";
import { continuedOrigin } from "./continueElsewhere";
import { writeHandoffArchive } from "./handoffArchive";

const ARCHIVE = /^## Conversation archive\s*$/m;
const LEGACY_SOURCE = /\bMonoCode session ([A-Za-z0-9_-]+)/;

function handoffText(session: Session): string {
  return (
    session.handoffCard?.brief ??
    [...session.blocks].reverse().find((block) => block.role === "handoff")
      ?.text ??
    ""
  );
}

function sourceOf(session: Session) {
  return (
    continuedOrigin(session.id) ??
    (() => {
      const id = LEGACY_SOURCE.exec(handoffText(session))?.[1];
      return id ? { sessionId: id, throughBlockId: undefined } : null;
    })()
  );
}

export function needsHandoffRecovery(session: Session): boolean {
  return !ARCHIVE.test(handoffText(session)) && sourceOf(session) != null;
}

function withoutOldPointer(text: string): string {
  return text.replace(/^## Full transcript\s*\n[^\n]*(?:\n|$)/gm, "").trim();
}

/** Resolve the source chain before sending, instead of asking the user for app access. */
export async function prepareHandoffContext(
  session: Session,
  brief: string,
  load: (id: string) => Promise<Session | null>,
  write: (text: string) => Promise<string> = writeHandoffArchive,
): Promise<string> {
  const chain: Session[] = [];
  const seen = new Set<string>();
  let current = session;
  while (true) {
    if (seen.has(current.id) || chain.length >= 32) {
      throw new Error(
        "Could not restore the original conversation: handoff history contains a cycle or is too deep.",
      );
    }
    seen.add(current.id);
    chain.unshift(current);
    const source = sourceOf(current);
    if (!source) {
      break;
    }
    const original = await load(source.sessionId);
    if (!original) {
      if (ARCHIVE.test(handoffText(current))) {
        break;
      }
      throw new Error(
        `Could not restore the original conversation ${source.sessionId}; it is no longer saved in MonoCode.`,
      );
    }
    if (!sameProjectPath(original.cwd, session.cwd)) {
      throw new Error("Could not restore a handoff from a different project.");
    }
    const end = source.throughBlockId
      ? original.blocks.findIndex((block) => block.id === source.throughBlockId)
      : -1;
    if (source.throughBlockId && end < 0) {
      throw new Error(
        "Could not restore the selected handoff turn; the original conversation changed.",
      );
    }
    current =
      end < 0
        ? original
        : { ...original, blocks: original.blocks.slice(0, end + 1) };
  }
  const content = chain
    .map((entry) => {
      const prose = entry.blocks
        .filter(
          (block) =>
            !block.draft &&
            !block.internal &&
            ["user", "assistant", "plan", "tasks", "handoff"].includes(
              block.role,
            ),
        )
        .map(
          (block) =>
            `### ${block.role} (${block.id})\n${block.role === "user" ? operatorUserPrompt(block) : block.role === "handoff" ? withoutOldPointer(block.text) : block.text}`,
        )
        .join("\n\n");
      return `## Conversation ${entry.id}\nProject: ${entry.cwd}\nWorktree: ${entry.worktreeCwd ?? entry.cwd}\nTitle: ${entry.title}\n\n${prose}`;
    })
    .join("\n\n");
  const path = await write(
    `# Handoff conversation archive\n\nPrior conversation, in chronological order. User messages and plans are unabridged. The newest user message takes precedence over older requests. Tools, private reasoning and unsent drafts are excluded.\n\n${content}`,
  );
  // Fork (handoffBudget): searched on demand, not read whole, so a long
  // conversation is not loaded into the new agent's context all over again.
  return `${withoutOldPointer(brief)}\n\n## Conversation archive\nThe whole earlier conversation is in the local file ${JSON.stringify(path)}, one "### <role> (<message id>)" heading per message, oldest first. Do not read the whole file. When you need something this recap leaves out or trims, search it (for example grep for a message id named above, or a keyword) and read only the matching part. No /operator command or user resend is needed.`.trim();
}

/** Persist the reference so later turns and app restarts know recovery was supplied. */
export function recordHandoffContext(
  session: Session,
  from: HarnessId,
  brief: string,
): Session {
  const last = [...session.blocks]
    .reverse()
    .find((block) => block.role === "handoff");
  return last
    ? {
        ...session,
        blocks: session.blocks.map((block) =>
          block.id === last.id
            ? {
                ...block,
                text: brief,
                handoff: block.handoff
                  ? { ...block.handoff, pending: true }
                  : undefined,
              }
            : block,
        ),
      }
    : appendReadyHandoff(session, from, session.harness, brief);
}

/** Some adapters report failure as an event and resolve their send promise. */
export function finishHandoffContext(
  session: Session,
  brief: string,
  outcome: { failed: boolean; rawCommand: boolean },
): Session {
  const ready = isPreparingHandoff(session)
    ? completeHandoff(session, brief)
    : session;
  return outcome.failed || outcome.rawCommand ? ready : consumeHandoff(ready);
}
