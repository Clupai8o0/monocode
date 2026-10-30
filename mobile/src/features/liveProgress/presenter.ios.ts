import { liveProgressLink, type LiveProgress } from "./liveProgress";
import SessionActivity, { type SessionActivityProps } from "./SessionActivity.ios";

const toProps = (progress: LiveProgress): SessionActivityProps => ({
  title: progress.title,
  project: progress.project,
  step: progress.step,
  startedAt: progress.startedAt,
  sprite: progress.sprite,
  attention: progress.status !== "working",
});

let shownSession: string | null = null;

/**
 * Local updates only: a free Apple ID can't sign the push that would update it
 * while the app is suspended. The step can go stale then; the timer can't.
 * Asks iOS what's live each time, since the person can swipe a card away, and
 * one from before a restart would otherwise stay on the lock screen.
 */
export async function showProgress(progress: LiveProgress | null) {
  const [current, ...extra] = SessionActivity.getInstances();
  await Promise.all(extra.map((instance) => instance.end("immediate")));
  if (!progress) {
    await current?.end("immediate");
    shownSession = null;
    return;
  }
  if (current && shownSession === progress.sessionId) {
    await current.update(toProps(progress));
    return;
  }
  await current?.end("immediate");
  SessionActivity.start(toProps(progress), liveProgressLink(progress));
  shownSession = progress.sessionId;
}
