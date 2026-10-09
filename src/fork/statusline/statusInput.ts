/**
 * Fork feature: the JSON Claude Code pipes into a status line, rebuilt from
 * what MonoCode knows about a session, plus the artifact links it produced.
 */

import type { Block } from "../../features/sessions/model/session";
import type {
  ProviderRateLimits,
  RateLimitWindow,
} from "../../features/providers/model/rateLimits";

export type StatusSession = {
  id: string;
  cwd: string;
  worktreeCwd?: string;
  providerSessionId?: string;
  modelSettings: Record<string, string>;
  context?: { used: number; window?: number };
};

export type StatusModel = { id: string; name: string };

function window(limit: RateLimitWindow | null | undefined) {
  if (!limit) return undefined;
  return {
    used_percentage: limit.usedPercent,
    ...(limit.resetsAt ? { resets_at: Math.round(limit.resetsAt / 1000) } : {}),
  };
}

export function buildStatusInput(
  session: StatusSession,
  model: StatusModel,
  limits?: ProviderRateLimits,
): Record<string, unknown> {
  const cwd = session.worktreeCwd || session.cwd;
  const sid = session.providerSessionId;
  const input: Record<string, unknown> = {
    hook_event_name: "Status",
    cwd,
    workspace: { current_dir: cwd, project_dir: session.cwd },
    model: { id: model.id, display_name: model.name },
  };
  // The runner adds transcript_path; it knows the home folder.
  if (sid) input.session_id = sid;
  const effort = session.modelSettings.effort;
  if (effort) input.effort = { level: effort };
  const context = session.context;
  if (context && context.used > 0) {
    input.context_window = {
      ...(context.window ? { context_window_size: context.window } : {}),
      ...(context.window
        ? { used_percentage: Math.min(100, (context.used / context.window) * 100) }
        : {}),
      current_usage: { input_tokens: context.used },
    };
  }
  const five = window(limits?.session);
  const week = window(limits?.weekly);
  if (five || week) {
    input.rate_limits = {
      ...(five ? { five_hour: five } : {}),
      ...(week ? { seven_day: week } : {}),
    };
  }
  return input;
}

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g;

/** Every claude.ai artifact link in the session, newest first, without repeats. */
export function artifactLinks(blocks: readonly Block[]): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const texts = [block.text, block.tool?.detail, block.tool?.preview?.output];
    for (const text of texts) {
      if (typeof text !== "string") continue;
      for (const match of text.matchAll(ARTIFACT_URL)) {
        if (seen.has(match[0])) continue;
        seen.add(match[0]);
        links.push(match[0]);
      }
    }
  }
  return links;
}

/** Short chip label: the artifact id's first characters. */
export function artifactLabel(url: string): string {
  const id = url.slice(url.lastIndexOf("/") + 1);
  return id.length > 8 ? id.slice(0, 8) : id;
}
