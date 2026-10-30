/**
 * Fork feature: "Elsewhere". Agent sessions on a project that MonoCode did
 * not start (Claude Code in a terminal, the second account, Codex and the
 * other agents with a session registry), and sessions that ended by handing
 * over to a handoff file. Read-only: MonoCode shows them, it never drives them.
 *
 * The Mac reads its own with a Tauri command. A machine's host answers the
 * same two methods on `/rpc` and `/mobile`, in the shapes below:
 *
 * - `externalSessions.list {projectId?}` -> `{sessions: ExternalSession[],
 *   unfiled?: UnfiledExternalSession[]}`, every project's when `projectId` is
 *   absent. Only then does `unfiled` come too: the live sessions under no
 *   project, such as one in the home folder. Hosts before this field omit it.
 * - `externalSessions.read {projectId?, sessionId, before?, limit?}` ->
 *   `ExternalTranscriptPage`. `limit` defaults to 60 turns, at most 200.
 *   Without `projectId` it reads any live session on the machine, filed or
 *   not; hand-overs and handoff files still need their project. Hosts before
 *   this answer "Project is not registered on this machine".
 *
 * A host from before this feature answers with an error; callers then hide
 * the section rather than show the error.
 */

export type ExternalSessionState = "running" | "idle" | "handed-over";

export type ExternalSession = {
  /** The agent's session id, or `handoff:<path>` for a handoff file alone. */
  id: string;
  /** The MonoCode project on that machine whose folder holds `cwd`. */
  projectId: string;
  /** "claude", "claude-cx", "codex", "opencode", "dsh", "kimi" or "grok". */
  source: string;
  /** Its session name, e.g. "monocode-16". */
  name?: string;
  /** Its working folder on its machine. */
  cwd: string;
  branch?: string;
  state: ExternalSessionState;
  /** Milliseconds since the epoch. */
  startedAt?: number;
  updatedAt?: number;
  /** Its latest status note (`claims.py note`). */
  note?: string;
  /** Its handoff file, relative to the project folder. */
  handoffPath?: string;
  /** Whether `externalSessions.read` returns its turns. */
  hasTranscript: boolean;
};

/** A live session whose folder is under none of the machine's projects. */
export type UnfiledExternalSession = Omit<ExternalSession, "projectId">;

export type ExternalTurn = {
  role: "user" | "assistant" | "tool";
  text: string;
  at?: number;
};

export type ExternalTranscriptPage = {
  /** Oldest first. */
  turns: ExternalTurn[];
  /** Pass back as `before` for older turns; absent at the start. */
  before?: number;
  /** The handoff file, on the first page of a session that has one. */
  handoff?: { path: string; text: string };
  /** Some text was cut to keep the page small. */
  truncated?: boolean;
};

/** Where a project's sessions live: this Mac, or a machine's host. */
export type ExternalSessionsTarget =
  | { kind: "local"; projectId: string; cwd: string }
  | { kind: "remote"; machineId: string; projectId: string };
