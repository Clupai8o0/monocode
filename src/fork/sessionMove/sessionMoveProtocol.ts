/**
 * Fork feature: move a running session and its work to another machine.
 * One protocol for the host (host/session-move.ts, capability
 * "session.move.v1") and the Mac (src-tauri/src/fork_session_move.rs): the app
 * sends the same ops to both, `sessionMove {op, ...}` on /rpc or the
 * `fork_session_move` command, and drives the steps itself
 * (sessionMoveRunner.ts).
 *
 * What the other machine sends is checked, not trusted: ids and names against
 * the patterns here, paths inside a pack against `packPathOk`, and the client
 * rule again on the receiving end.
 */

export const SESSION_MOVE_CAPABILITY = "session.move.v1";

/** Base64 of this many bytes stays well under the desktop's 16 MiB limit. */
export const CHUNK_BYTES = 3 * 1024 * 1024;
export const WRITE_MAX_BASE64 = 8 * 1024 * 1024;
export const PACK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const IGNORED_MAX = 100;
/** A longer folder name gets a hash in Claude's project key, so resume misses. */
export const PROJECT_KEY_MAX = 200;

export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MOVE_ID = /^[A-Za-z0-9-]{8,64}$/;
export const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const BUNDLE_FILE = "commits.bundle";
export const PATCH_FILE = "changes.patch";
export const UNTRACKED_DIR = "untracked";
/** `convo/session/<id>.jsonl`, `convo/session/<id>/...`, `convo/history/<id>/...`. */
export const CONVO_DIR = "convo";

export type MoveAccount = "main" | "cx" | "other";

export type PackFile = {
  path: string;
  size: number;
  sha256: string;
  executable?: boolean;
};

export type PackLink = { path: string; target: string };

export type MoveManifest = {
  version: 1;
  sessionId: string;
  head: string;
  /** The source's branch, for the card only. */
  branch?: string;
  sourcePath: string;
  files: PackFile[];
  links: PackLink[];
  /** Git-ignored names on the source, which do not travel. Never contents. */
  ignored: string[];
  ignoredMore: number;
};

export type MoveRemote = { name: string; url: string };

export type InspectResult = {
  repoRoot: string;
  remotes: MoveRemote[];
  hasTranscript: boolean;
  account: MoveAccount;
};

export type CheckResult =
  | { ok: true; repo: string; remoteName: string; matchedUrl: string; queued?: boolean }
  | { ok: false; reason: string };

export type SourceState = {
  state: "idle" | "busy" | "waiting" | "gone";
  name?: string;
  cwd?: string;
  account?: MoveAccount;
};

export type UnpackCodeResult = { repo: string; cwd: string; branch: string };
export type StartResult = { name: string };
export type ConfirmResult = {
  state: "up" | "queued" | "starting" | "failed";
  detail?: string;
};

/** Case-insensitive like the Mac's disk: upwork work other than Panoptic. */
const CLIENT_PATH = /\/projects\/upwork(?:\/(?!panoptic(?:\/|$))|$)/i;

export function isClientPath(path: string): boolean {
  return CLIENT_PATH.test(path.replace(/\\/g, "/").replace(/\/+$/, ""));
}

/** One path segment safe for a window, a folder and a branch. */
export function moveSlug(name: string | undefined, sessionId: string): string {
  const clean = (name ?? "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+/, "")
    .slice(0, 48)
    .replace(/(?:\.lock)+$/i, "")
    .replace(/[-.]+$/, "");
  return clean || `session-${sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}

/** `git@github.com:a/b.git`, `https://github.com/a/b` and `ssh://...` as one. */
export function normalizeRemoteUrl(url: string): string {
  let text = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/]+)\/(.*)$/i.exec(text);
  if (scheme) {
    text = `${scheme[1].replace(/:\d+$/, "").toLowerCase()}/${scheme[2]}`;
  } else {
    const scp = /^(?:[^/@]*@)?([^/:]+):(.*)$/.exec(text);
    if (scp) text = `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+/, "")}`;
  }
  return text;
}

function segmentsOk(segments: string[]): boolean {
  return (
    segments.length > 0 &&
    segments.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        part.toLowerCase() !== ".git" &&
        !part.includes("\\") &&
        !part.includes("\0"),
    )
  );
}

/** A path inside a pack, for this session only. */
export function packPathOk(path: string, sessionId: string): boolean {
  if (typeof path !== "string" || path.startsWith("/")) return false;
  const segments = path.split("/");
  if (!segmentsOk(segments)) return false;
  if (path === BUNDLE_FILE || path === PATCH_FILE) return true;
  if (segments[0] === UNTRACKED_DIR) return segments.length > 1;
  if (segments[0] !== CONVO_DIR) return false;
  if (segments[1] === "session") {
    return (
      (segments.length === 3 && segments[2] === `${sessionId}.jsonl`) ||
      (segments.length > 3 && segments[2] === sessionId)
    );
  }
  return segments[1] === "history" && segments.length > 3 && segments[2] === sessionId;
}

/** The manifest's shape and every path in it, or a plain reason. */
export function manifestProblem(value: unknown): string | null {
  const manifest = value as MoveManifest;
  if (!manifest || typeof manifest !== "object" || manifest.version !== 1)
    return "The move's file list is not one this machine reads";
  if (typeof manifest.sessionId !== "string" || !SESSION_ID.test(manifest.sessionId))
    return "Invalid session id";
  if (typeof manifest.head !== "string" || !COMMIT_ID.test(manifest.head))
    return "Invalid commit id";
  if (typeof manifest.sourcePath !== "string") return "Invalid source folder";
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.links))
    return "The move's file list is not one this machine reads";
  for (const file of manifest.files) {
    if (
      !file ||
      !packPathOk(file.path, manifest.sessionId) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      return `Refused a file in the move: ${String(file?.path)}`;
  }
  for (const link of manifest.links) {
    if (
      !link ||
      typeof link.target !== "string" ||
      !link.path?.startsWith(`${UNTRACKED_DIR}/`) ||
      !packPathOk(link.path, manifest.sessionId)
    )
      return `Refused a link in the move: ${String(link?.path)}`;
  }
  return null;
}
