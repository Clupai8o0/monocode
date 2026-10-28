import type {
  ExternalSession,
  ExternalTranscriptPage,
} from "@/features/workspace/types";

import { relativeTime } from "@/features/workspace/relativeTime";

/** How long a connection that can't list them is left alone. */
export const UNSUPPORTED_MS = 5 * 60_000;

type Command = <T>(method: string, params?: object) => Promise<T>;

/** Raised when the desktop or host is from before "Elsewhere". */
export class ExternalUnsupported extends Error {
  constructor() {
    super("Not supported on this machine");
  }
}

/**
 * The errors an older desktop or host answers an unknown method with: the
 * desktop's "Unsupported mobile operation", the host's "Not available on
 * this machine yet", and the like.
 */
export function isUnsupportedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unsupported|not supported|unknown (method|command|operation)|not available on this machine|method not found/i.test(
    message,
  );
}

/** Connections found not to answer, with when that was seen. */
const unsupported = new Map<string, number>();

export function markUnsupported(connection: string, now = Date.now()) {
  unsupported.set(connection, now);
}

export function isMarkedUnsupported(connection: string, now = Date.now()) {
  const at = unsupported.get(connection);
  if (at === undefined) return false;
  if (now - at >= UNSUPPORTED_MS) {
    unsupported.delete(connection);
    return false;
  }
  return true;
}

/** For tests. */
export function resetUnsupported() {
  unsupported.clear();
}

async function call<T>(
  command: Command,
  connection: string,
  method: string,
  params: object,
): Promise<T> {
  if (isMarkedUnsupported(connection)) throw new ExternalUnsupported();
  try {
    return await command<T>(method, params);
  } catch (error) {
    if (isUnsupportedError(error)) {
      markUnsupported(connection);
      throw new ExternalUnsupported();
    }
    throw error;
  }
}

export async function listExternalSessions(
  command: Command,
  connection: string,
  projectId: string,
) {
  const value = await call<{ sessions?: ExternalSession[] }>(
    command,
    connection,
    "externalSessions.list",
    { projectId },
  );
  return value.sessions ?? [];
}

export function readExternalSession(
  command: Command,
  connection: string,
  projectId: string,
  sessionId: string,
  before?: number,
) {
  const params: Record<string, unknown> = { projectId, sessionId };
  if (before !== undefined) params.before = before;
  return call<ExternalTranscriptPage>(command, connection, "externalSessions.read", params);
}

/** The agent's short name, left out for the main Claude account. */
export function sourceLabel(source: string) {
  if (source === "claude") return undefined;
  if (source === "claude-cx") return "cx";
  return source;
}

const STATE_LABEL = {
  running: "Running",
  idle: "Idle",
  "handed-over": "Handed over",
} as const;

export function stateLabel(state: ExternalSession["state"]) {
  return STATE_LABEL[state] ?? "Running";
}

/** A row's title: its name, else its handoff file, else a short id. */
export function sessionTitle(session: ExternalSession) {
  if (session.name) return session.name;
  if (session.handoffPath) return session.handoffPath.split("/").pop() || session.handoffPath;
  return session.id.slice(0, 8);
}

/** The row's meta line: source, branch and age, as present. */
export function metaParts(session: ExternalSession, now = Date.now()) {
  const parts: string[] = [];
  const source = sourceLabel(session.source);
  if (source) parts.push(source);
  if (session.branch) parts.push(session.branch);
  if (session.updatedAt) parts.push(relativeTime(session.updatedAt, now));
  return parts;
}

/**
 * A session id made safe for a route param. Expo Router decodes a pushed
 * param once reading the path and again in useLocalSearchParams, so an id
 * holding "%" or "/" would not come back intact. This leaves no "%" or "/":
 * percent-encode, escape "~", then write each "%" as "~". Plain ids pass
 * through unchanged.
 */
export function sessionIdToRoute(id: string) {
  return encodeURIComponent(id).replace(/~/g, "%7E").replace(/%/g, "~");
}

/** The session id back from its route param (see sessionIdToRoute). */
export function sessionIdFromRoute(param: string) {
  try {
    return decodeURIComponent(param.replace(/~/g, "%"));
  } catch {
    return param;
  }
}
