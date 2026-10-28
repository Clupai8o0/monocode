/**
 * Fork: sessions on other machines can message this one only while Remote
 * Control is on. The terminal turns it on at start when the user's
 * `remoteControlAtStartup` setting says so. Claude gives SDK hosts the same
 * verdict in its `initialize` reply and leaves the asking to them.
 */

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const asked = new WeakSet<object>();

/**
 * The `remote_control` request to send after `rec`, at most once per
 * `session`: only when `rec` is Claude's `initialize` reply and it says Remote
 * Control should start with the session.
 */
export function remoteControlRequest(
  session: object,
  rec: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const outer = record(rec.response);
  const reply = record(outer?.response);
  if (
    asked.has(session) ||
    outer?.subtype !== "success" ||
    reply?.remote_control_auto_enable !== true ||
    reply.remote_control_available === false
  ) {
    return undefined;
  }
  asked.add(session);
  return { subtype: "remote_control", enabled: true };
}
