import type { Block } from "./session";
import { monoWorkStatus } from "./monoWorkStatus";

/** After this long with no new transcript activity, the fold line says so. */
export const LIVE_FOLD_QUIET_MS = 90_000;

/**
 * A compact fingerprint of what the live turn is doing. When it changes, the
 * quiet clock resets — streamed chunks of the same block count as activity.
 */
export function liveActivityFingerprint(
  blocks: readonly Block[],
  backgroundTasks?: readonly string[],
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.internal || block.draft) continue;
    const tool = block.tool;
    parts.push(
      [
        block.id,
        block.role,
        block.streaming ? "1" : "0",
        String(block.text.length),
        tool?.status ?? "",
        tool?.callId ?? "",
        tool?.background ? "bg" : "",
        String(block.agentRun?.steps.length ?? 0),
      ].join(":"),
    );
  }
  if (backgroundTasks?.length) {
    parts.push(`bg:${backgroundTasks.join("\0")}`);
  }
  return parts.join("|");
}

/** "nothing new for 2m" — same idea as the background-agents quiet hint. */
export function liveQuietLabel(quietMs: number): string {
  const minutes = Math.floor(quietMs / 60_000);
  if (minutes < 1) return "nothing new for <1m";
  if (minutes < 60) return `nothing new for ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? `nothing new for ${hours}h ${rest}m`
    : `nothing new for ${hours}h`;
}

/**
 * The live fold line: who is working, what they are doing, how long, and
 * whether the trail has gone quiet.
 *
 * `Opus 5.5 · Thinking… · 8m 37s`
 * `Opus 5.5 · Running command… · 2m · nothing new for 6m`
 */
export function liveFoldStatusText(input: {
  elapsedMs: number | null;
  modelName?: string;
  blocks: readonly Block[];
  paused: boolean;
  waitingLabel?: string;
  backgroundTasks?: readonly string[];
  quietMs?: number | null;
}): string {
  if (input.paused) {
    return input.waitingLabel ?? "Waiting for approval";
  }

  const who = input.modelName?.trim();
  const activity = monoWorkStatus([...input.blocks], true).label;
  const elapsed = formatLiveElapsed(input.elapsedMs);
  const parts: string[] = [];
  if (who) parts.push(who);
  parts.push(activity);
  if (elapsed) parts.push(elapsed);

  if (input.backgroundTasks?.length) {
    parts.push(
      input.backgroundTasks.length === 1
        ? "running in background"
        : `${input.backgroundTasks.length} tasks running in background`,
    );
  }

  if (input.quietMs != null && input.quietMs >= LIVE_FOLD_QUIET_MS) {
    parts.push(liveQuietLabel(input.quietMs));
  }

  return parts.join(" · ");
}

function formatLiveElapsed(elapsedMs: number | null): string | null {
  if (elapsedMs == null) return null;
  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
