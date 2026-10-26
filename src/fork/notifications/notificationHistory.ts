import type { Session } from "../../features/sessions/model/session";
import type {
  NotificationEvent,
  NotificationText,
} from "../../features/notifications/model/notifications";
import { projectName } from "../../shared/lib/paths";

export const HISTORY_LIMIT = 120;
export const HISTORY_PREFIX = "monocode.notificationHistory.v1.";
const EVENT_PREFIX = `${HISTORY_PREFIX}event.`;
const READ_PREFIX = `${HISTORY_PREFIX}read.`;

export type HistoryNotification = {
  id: string;
  sessionId: string;
  projectId: string;
  project: string;
  title: string;
  body: string;
  kind: "finished" | "question" | "approval";
  occurredAt: number;
  readAt?: number;
};

/** Only actual announcements are recorded; opening old transcripts creates none. */
export function historyNotification(
  session: Session,
  event: NotificationEvent,
  text: NotificationText,
  projectId: string,
  occurredAt: number,
): HistoryNotification | null {
  const turn = [...session.blocks]
    .reverse()
    .find((block) => block.role === "user" && !block.draft);
  if (!turn || session.inboxAsk) {
    return null;
  }
  const kind = event === "finished" ? "finished" : event.kind;
  return {
    id: JSON.stringify([
      session.id,
      turn.id,
      kind,
      event === "finished" ? null : event.requestId,
    ]),
    sessionId: session.id,
    projectId,
    project: projectName(session.cwd),
    title: text.subtitle,
    body: text.body,
    kind,
    occurredAt,
  };
}

function parseEntry(raw: string | null): HistoryNotification | null {
  try {
    const value = JSON.parse(raw ?? "null");
    if (
      !value ||
      !["id", "sessionId", "projectId", "project", "title", "body"].every(
        (key) => typeof value[key] === "string",
      ) ||
      !["finished", "question", "approval"].includes(value.kind) ||
      !Number.isFinite(value.occurredAt) ||
      value.occurredAt < 0 ||
      value.occurredAt > 8_640_000_000_000_000
    ) {
      return null;
    }
    return {
      id: value.id,
      sessionId: value.sessionId,
      projectId: value.projectId,
      project: value.project,
      title: value.title.slice(0, 500),
      body: value.body.slice(0, 500),
      kind: value.kind,
      occurredAt: value.occurredAt,
    };
  } catch {
    return null;
  }
}

/** Independent event/read keys avoid cross-window read/modify/write losses. */
export class NotificationHistory {
  private memory = new Map<string, string>();
  private volatile = new Map<string, string>();
  private cached: HistoryNotification[] = [];
  private signature = "";

  constructor(private storage: () => Storage) {}

  private read(key: string): string | null {
    try {
      return this.volatile.get(key) ?? this.storage().getItem(key);
    } catch {
      return this.memory.get(key) ?? null;
    }
  }

  private write(key: string, value: string): void {
    this.memory.set(key, value);
    try {
      this.storage().setItem(key, value);
      this.volatile.delete(key);
    } catch {
      this.volatile.set(key, value);
    }
  }

  private remove(key: string): void {
    this.memory.delete(key);
    this.volatile.delete(key);
    try {
      this.storage().removeItem(key);
    } catch {
      /* Storage may be unavailable. */
    }
  }

  getSnapshot = (): HistoryNotification[] => {
    const keys = new Set(this.volatile.keys());
    try {
      const storage = this.storage();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.startsWith(EVENT_PREFIX)) {
          keys.add(key);
        }
      }
    } catch {
      for (const key of this.memory.keys()) {
        keys.add(key);
      }
    }
    const entries = [...keys]
      .filter((key) => key.startsWith(EVENT_PREFIX))
      .flatMap((key) => {
        const entry = parseEntry(this.read(key));
        if (!entry) {
          return [];
        }
        const readAt = Number(
          this.read(READ_PREFIX + encodeURIComponent(entry.id)),
        );
        return [
          {
            ...entry,
            ...(Number.isFinite(readAt) && readAt > 0 ? { readAt } : {}),
          },
        ];
      })
      .sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id))
      .slice(0, HISTORY_LIMIT);
    const signature = JSON.stringify(entries);
    if (signature !== this.signature) {
      this.signature = signature;
      this.cached = entries;
    }
    return this.cached;
  };

  record(entry: HistoryNotification): boolean {
    const key = EVENT_PREFIX + encodeURIComponent(entry.id);
    if (parseEntry(this.read(key))) {
      return false;
    }
    this.write(key, JSON.stringify(entry));
    // Capture deletion candidates first. A different window can insert an
    // event while we read the retained snapshot; unseen keys must survive.
    const keys = new Set(this.memory.keys());
    try {
      const storage = this.storage();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key) {
          keys.add(key);
        }
      }
    } catch {
      /* The in-memory history remains bounded too. */
    }
    const candidates = new Map(
      [...keys]
        .filter((candidate) => candidate.startsWith(EVENT_PREFIX))
        .map((candidate) => [candidate, this.read(candidate)]),
    );
    // Rank the captured values themselves. Re-enumerating mutable Storage
    // here can skip an entry when another window prunes lower indices.
    const keep = new Set(
      [...candidates]
        .flatMap(([key, value]) => {
          const entry = parseEntry(value);
          return entry ? [{ key, entry }] : [];
        })
        .sort(
          (a, b) =>
            b.entry.occurredAt - a.entry.occurredAt ||
            a.entry.id.localeCompare(b.entry.id),
        )
        .slice(0, HISTORY_LIMIT)
        .map(({ key }) => key),
    );
    for (const [stale, value] of candidates) {
      if (!keep.has(stale) && this.read(stale) === value) {
        this.remove(stale);
        this.remove(READ_PREFIX + stale.slice(EVENT_PREFIX.length));
      }
    }
    return true;
  }

  markRead(ids: readonly string[], now = Date.now()): void {
    for (const id of ids) {
      if (parseEntry(this.read(EVENT_PREFIX + encodeURIComponent(id)))) {
        this.write(READ_PREFIX + encodeURIComponent(id), String(now));
      }
    }
  }
}
