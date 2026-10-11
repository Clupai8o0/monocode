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
        ? {
            used_percentage: Math.min(
              100,
              (context.used / context.window) * 100,
            ),
          }
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

const ARTIFACT_URL =
  /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g;

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

/** What the status script sends for the composer layout. */
export type StatusData = {
  account?: string;
  compactions: number;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** The composer layout's JSON, or null for an older script's ANSI line. */
export function parseStatusData(output: string): StatusData | null {
  const text = output.trim();
  if (!text.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const account =
    typeof data.account === "string" && data.account.trim()
      ? data.account.trim()
      : undefined;
  return {
    ...(account ? { account } : {}),
    compactions: count(data.compactions),
  };
}

export type UsageFact = {
  key: "session" | "weekly";
  label: string;
  /** Percent shown: used, or remaining when the person prefers that. */
  percent: number;
  /** Percent of the window used, for the warning colour. */
  used: number;
  resetsIn?: string;
};

function compactDuration(ms: number): string {
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${String(mins % 60).padStart(2, "0")}`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** The 5-hour and weekly windows, as the composer shows them. */
export function usageFacts(
  limits: ProviderRateLimits | undefined,
  showRemaining: boolean,
  now: number,
): UsageFact[] {
  const facts: UsageFact[] = [];
  const add = (
    key: UsageFact["key"],
    label: string,
    limit: RateLimitWindow | null | undefined,
  ) => {
    if (!limit || !Number.isFinite(limit.usedPercent)) return;
    const used = Math.round(Math.min(100, Math.max(0, limit.usedPercent)));
    facts.push({
      key,
      label,
      percent: showRemaining ? 100 - used : used,
      used,
      ...(limit.resetsAt
        ? { resetsIn: compactDuration(limit.resetsAt - now) }
        : {}),
    });
  };
  add("session", "5h", limits?.session);
  add("weekly", "wk", limits?.weekly);
  return facts;
}
