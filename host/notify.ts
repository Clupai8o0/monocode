import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostEngine } from "./engine";
import type { HostSession } from "../src/features/connections/model/protocol";
import { sessionDisplayTitle } from "../src/features/sessions/model/session";

/**
 * Pushes to the phone through ntfy (https://ntfy.sh), self-hosted: a turn that
 * finished, failed or was stopped, and a session that needs the user. The phone's own notifications only
 * work while the app runs; these arrive with it closed, through the ntfy app.
 *
 * Off until `<data dir>/notify.json` names a server and topic, which
 * `monocode-host notify <server>` writes. The topic is random and long: on a
 * server only the tailnet reaches, it is what keeps others off it.
 */

export type NotifyConfig = { server: string; topic: string };

const FILE = "notify.json";
/** How often sessions are looked at for one newly waiting on the user. */
const SCAN_MS = 3_000;
const TIMEOUT_MS = 10_000;

const valid = (value: unknown): value is NotifyConfig => {
  const config = value as Partial<NotifyConfig> | null;
  return (
    typeof config?.server === "string" &&
    /^https?:\/\/[^\s]+$/.test(config.server) &&
    typeof config.topic === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(config.topic)
  );
};

export function readNotifyConfig(dataDir: string): NotifyConfig | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    if (valid(value))
      return { server: value.server.replace(/\/+$/, ""), topic: value.topic };
  } catch {
    // No file: notifications are off.
  }
  return null;
}

export function writeNotifyConfig(
  dataDir: string,
  server: string,
  topic = `monocode-${randomBytes(12).toString("hex")}`,
): NotifyConfig {
  const config = { server: server.replace(/\/+$/, ""), topic };
  if (!valid(config))
    throw new Error("Give an http(s) server address and a plain topic name");
  const file = join(dataDir, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return config;
}

export type Push = {
  title: string;
  message: string;
  tags: string[];
  priority: number;
};

/** The push for a turn that ended. */
export function settledPush(
  title: string,
  outcome: { error?: string; cancelled: boolean; interrupted: boolean },
): Push {
  if (outcome.cancelled)
    return {
      title: `Stopped: ${title}`,
      message: "Stopped by you.",
      tags: ["stop_button"],
      priority: 2,
    };
  if (outcome.interrupted || outcome.error)
    return {
      title: `Failed: ${title}`,
      message: (outcome.error || "The turn was interrupted.").slice(0, 300),
      tags: ["warning"],
      priority: 4,
    };
  return {
    title: `Done: ${title}`,
    message: "The turn finished.",
    tags: ["white_check_mark"],
    priority: 3,
  };
}

/**
 * The push for a session waiting on the user, when what it waits on is new:
 * `before` and `now` name the request (empty when none), so a second approval
 * right after the first one counts too.
 */
export function waitingPush(
  before: string | undefined,
  now: string,
  title: string,
): Push | null {
  if (before === undefined || !now || before === now) return null;
  return {
    title: `Needs you: ${title}`,
    message: "Waiting for your approval or answer.",
    tags: ["raised_hand"],
    priority: 4,
  };
}

/** What a session waits on the user for, as one key; empty when nothing. */
export function waitingOn(session: HostSession): string {
  const approval = session.session.blocks.find(
    (block) => block.approval && !block.approval.decided,
  )?.approval;
  if (approval) return `${session.runId ?? ""}:approval:${approval.requestId}`;
  const question = session.session.pendingQuestion;
  if (question) return `${session.runId ?? ""}:question:${question.requestId}`;
  return "";
}

/**
 * Pushes each turn that ends, as the engine reports it, and each session that
 * starts waiting on the user, looked for every few seconds (a wait lasts
 * until answered, so a look that often never misses one).
 */
export function startNotifications(
  engine: HostEngine,
  dataDir: string,
  send: (config: NotifyConfig, push: Push) => Promise<void> = publish,
) {
  const deliver = (push: Push | null) => {
    const config = push && readNotifyConfig(dataDir);
    if (push && config)
      void send(config, push).catch((error) =>
        console.debug("[monocode] notification", error),
      );
  };
  const previous = engine.onSettled;
  engine.onSettled = (value, outcome) => {
    previous?.(value, outcome);
    deliver(
      settledPush(
        sessionDisplayTitle(value.session.title, value.session.harness),
        outcome,
      ),
    );
  };
  const waiting = new Map<string, string>();
  // Waits already there when the host starts were pushed before, or are stale;
  // a session seen for the first time after that was not waiting before.
  let primed = false;
  const scan = () => {
    for (const project of engine.store.projects())
      for (const summary of engine.store.summaries(project.id)) {
        if (summary.archived) continue;
        const now = summary.needsInput
          ? waitingOn(engine.store.session(summary.id))
          : "";
        deliver(
          waitingPush(
            waiting.get(summary.id) ?? (primed ? "" : undefined),
            now,
            sessionDisplayTitle(summary.title, summary.harness),
          ),
        );
        waiting.set(summary.id, now);
      }
    primed = true;
  };
  const safeScan = () => {
    try {
      scan();
    } catch (error) {
      console.debug("[monocode] notification scan", error);
    }
  };
  safeScan();
  const timer = setInterval(safeScan, SCAN_MS);
  timer.unref();
  return {
    scan,
    stop: () => {
      clearInterval(timer);
      engine.onSettled = previous;
    },
  };
}

/** One push, as ntfy's JSON publish takes it (titles may be any text). */
async function publish(config: NotifyConfig, push: Push): Promise<void> {
  const response = await fetch(config.server, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: config.topic, ...push }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
}
