/**
 * A message another Claude Code session sent into this one (Claude Code's
 * SendMessage). It arrives as a meta user turn whose text wraps the body in
 * `<cross-session-message from=".." from-name=".." from-mode="..">`, followed
 * by Claude Code's own note to the model. Only the body is for the reader.
 */
export type PeerMessage = {
  /** Session name the sender goes by, e.g. "panoptic-8c". */
  name: string;
  /** Raw address, e.g. "uds:/tmp/cc-socks/88142.sock". */
  from?: string;
  /** Sender's permission mode, e.g. "bypass". */
  mode?: string;
  /** When MonoCode received it, epoch ms (MonoCode's own `at` attribute). */
  at?: number;
  body: string;
};

const TAG =
  /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/;
const ATTR = /([a-z-]+)="([^"]*)"/g;

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(ATTR)) {
    out[match[1]] = match[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  return out;
}

/** The sender and body of a peer message, or null when `text` is not one. */
export function parsePeerMessage(text: string): PeerMessage | null {
  const match = TAG.exec(text);
  if (!match) {
    return null;
  }
  const attrs = attributes(match[1]);
  const body = match[2].trim();
  const from = attrs.from || undefined;
  const name = attrs["from-name"] || peerNameFromAddress(from) || "Session";
  const at = Number(attrs.at);
  return {
    name,
    ...(from ? { from } : {}),
    ...(attrs["from-mode"] ? { mode: attrs["from-mode"] } : {}),
    ...(Number.isFinite(at) && at > 0 ? { at } : {}),
    body: unescapeText(body),
  };
}

/**
 * The stored form of a peer message: just the tag and body, without Claude
 * Code's note to the model, stamped with the time it arrived.
 */
export function peerMessageText(message: PeerMessage): string {
  const attrs = [
    message.from ? `from="${escapeAttr(message.from)}"` : "",
    `from-name="${escapeAttr(message.name)}"`,
    message.mode ? `from-mode="${escapeAttr(message.mode)}"` : "",
    message.at ? `at="${message.at}"` : "",
  ].filter(Boolean);
  return `<cross-session-message ${attrs.join(" ")}>\n${escapeText(message.body)}\n</cross-session-message>`;
}

/** The pid in a sender address like "uds:/tmp/cc-socks/88142.sock". */
export function peerPid(from: string | undefined): number | undefined {
  const pid = Number(from?.match(/(\d+)\.sock$/)?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** Keeps a body that quotes the closing tag from ending the message early. */
function escapeText(value: string): string {
  return value.replace(
    /<\/cross-session-message>/g,
    "&lt;/cross-session-message>",
  );
}

function unescapeText(value: string): string {
  return value.replace(
    /&lt;\/cross-session-message>/g,
    "</cross-session-message>",
  );
}

/** "uds:/tmp/cc-socks/88142.sock" -> "pid 88142", for senders without a name. */
function peerNameFromAddress(from: string | undefined): string | undefined {
  const pid = peerPid(from);
  return pid ? `pid ${pid}` : undefined;
}

/** "01:12": the clock time a peer message arrived, in the user's locale. */
export function formatPeerTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}
