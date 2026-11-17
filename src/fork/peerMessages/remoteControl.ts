/**
 * Fork: Remote Control for a Claude session. While it is on, the session
 * shows in the Claude app on the phone (and claude.ai/code), which can read
 * and drive it, and sessions on other machines can message it.
 *
 * It starts with the session when Claude's `remoteControlAtStartup` setting
 * says so (Claude gives SDK hosts that verdict in its `initialize` reply and
 * leaves the asking to them), or when the user turned it on for this session
 * in MonoCode. The user can also turn it on or off while the session runs.
 */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const asked = new WeakSet<object>();
/** Remote Control requests sent per session, by request id: on or off. */
const pending = new WeakMap<object, Map<string, boolean>>();

/** What Claude's `initialize` reply says about Remote Control, if it is one. */
function initializeVerdict(
  rec: Record<string, unknown>,
): { auto: boolean; available: boolean } | undefined {
  const outer = record(rec.response);
  const reply = record(outer?.response);
  if (outer?.subtype !== "success" || !reply) {
    return undefined;
  }
  // Older Claude builds leave both fields out of the reply.
  if (
    !("remote_control_auto_enable" in reply) &&
    !("remote_control_available" in reply)
  ) {
    return undefined;
  }
  return {
    auto: reply.remote_control_auto_enable === true,
    available: reply.remote_control_available !== false,
  };
}

/**
 * The `remote_control` request to send after `rec`, at most once per
 * `session`: only when `rec` is Claude's `initialize` reply and Remote Control
 * should start with the session. The user's `choice` for this session wins:
 * true turns it on, false keeps it off; with none, Claude's setting decides.
 */
export function remoteControlRequest(
  session: object,
  rec: Record<string, unknown>,
  choice?: boolean,
): Record<string, unknown> | undefined {
  if (asked.has(session)) {
    return undefined;
  }
  const verdict = initializeVerdict(rec);
  if (!verdict?.available || !(choice ?? verdict.auto)) {
    return undefined;
  }
  asked.add(session);
  return remoteControlSwitch(true);
}

/** True when `rec` is Claude's `initialize` reply saying it can't start. */
export function remoteControlUnavailable(rec: Record<string, unknown>): boolean {
  return initializeVerdict(rec)?.available === false;
}

/** The request that turns Remote Control on or off. */
export function remoteControlSwitch(enabled: boolean): Record<string, unknown> {
  return { subtype: "remote_control", enabled };
}

/** Note a Remote Control request sent to `session`, to read its reply. */
export function trackRemoteControl(
  session: object,
  requestId: string,
  enabled: boolean,
): void {
  asked.add(session);
  let sent = pending.get(session);
  if (!sent) {
    sent = new Map();
    pending.set(session, sent);
  }
  sent.set(requestId, enabled);
}

export type RemoteControlReply =
  | { enabled: boolean; ok: true; url?: string }
  | { enabled: boolean; ok: false; error: string };

/**
 * Claude's reply to a Remote Control request sent to `session`, or undefined
 * when `rec` answers something else. Turning it on returns the session's
 * link, which opens it on the phone.
 */
export function remoteControlReply(
  session: object,
  rec: Record<string, unknown>,
): RemoteControlReply | undefined {
  const outer = record(rec.response);
  const requestId = text(outer?.request_id);
  const sent = pending.get(session);
  if (!requestId || !sent?.has(requestId)) {
    return undefined;
  }
  const enabled = sent.get(requestId) === true;
  sent.delete(requestId);
  if (outer?.subtype !== "success") {
    return {
      enabled,
      ok: false,
      error: text(outer?.error) ?? "Claude could not change Remote Control",
    };
  }
  const reply = record(outer.response);
  const url = [reply?.session_url, reply?.connect_url]
    .map(text)
    .find((link) => link !== undefined && /^https:\/\//.test(link));
  return url ? { enabled, ok: true, url } : { enabled, ok: true };
}
