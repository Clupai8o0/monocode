import { pixelSprite } from "@/features/mascots/pixelMascots";
import { projectMascot } from "@/features/mascots/projectMascots";
import type { SessionSummary } from "@/features/workspace/types";

/**
 * What the lock screen shows for a running session: a Live Activity on iOS, an
 * ongoing notification on Android, from the same content.
 */
export type LiveProgress = {
  sessionId: string;
  projectId: string;
  title: string;
  project: string;
  status: "working" | "approval" | "question";
  step: string;
  /** Epoch ms when this turn started. */
  startedAt: number;
  /** The project mascot's 8×8 rows, `#` filled. */
  sprite: string[];
  /** How many other sessions are running too. */
  others: number;
};

type Project = { id: string; name: string; mascot?: string };

const STEP = {
  approval: "Needs your approval",
  question: "Has a question for you",
} as const;

/** Whatever needs the person first, then the most recently started. */
export function pickLiveProgress(
  sessions: readonly SessionSummary[],
  projects: readonly Project[],
  now: number,
): LiveProgress | null {
  const running = sessions.filter((session) => session.busy || session.waiting);
  if (running.length === 0) return null;
  const started = (session: SessionSummary) =>
    session.busySince ?? session.updatedAt;
  const session = [...running].sort(
    (a, b) =>
      Number(!!b.waiting) - Number(!!a.waiting) || started(b) - started(a),
  )[0];
  const project = projects.find((entry) => entry.id === session.projectId);
  const name = project?.name ?? "";
  const status = session.waiting ?? "working";
  return {
    sessionId: session.id,
    projectId: session.projectId,
    title: session.title || "Session",
    project: name,
    status,
    step:
      session.waiting
        ? STEP[session.waiting]
        : session.step || "Working",
    startedAt: started(session) || now,
    sprite: [...pixelSprite(projectMascot(name, project?.mascot).name)],
    others: running.length - 1,
  };
}

/** Elapsed time is drawn by the system, so it needn't trigger an update. */
export function sameLiveProgress(a: LiveProgress | null, b: LiveProgress | null) {
  if (a === null || b === null) return a === b;
  return (
    a.sessionId === b.sessionId &&
    a.title === b.title &&
    a.project === b.project &&
    a.status === b.status &&
    a.step === b.step &&
    a.startedAt === b.startedAt &&
    a.others === b.others
  );
}

export function liveProgressLink(progress: LiveProgress): string {
  return `monocode://project/${encodeURIComponent(progress.projectId)}/session/${encodeURIComponent(progress.sessionId)}`;
}

export function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Android's card: a notification holds only text. */
export function ongoingNotificationText(progress: LiveProgress, now: number) {
  const others =
    progress.others > 0 ? `, ${progress.others} more running` : "";
  return {
    title: progress.title,
    subtitle: progress.project,
    body: `${progress.step} · ${formatElapsed(now - progress.startedAt)}${others}`,
  };
}
