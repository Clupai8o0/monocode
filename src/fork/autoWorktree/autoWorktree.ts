import { isEqualOrInside, pathKey } from "../../shared/lib/paths";
import { temporaryWorktreeBranchName } from "../../features/source-control/model/worktrees";

/**
 * Fork feature: new sessions get their own worktree when sharing a checkout
 * would get in the way. The owner ran many sessions in parallel and made no
 * worktree in three weeks, so the app makes the call and says what it did.
 */

export type AutoWorktreePolicy = "smart" | "always" | "never";
export type AutoWorktreeReason = "always" | "busy" | "dirty";

const POLICY_KEY = "monocode.fork.autoWorktree";
const COACH_KEY = "monocode.fork.autoWorktree.coachSeen";
const SLUG_LENGTH = 40;

const policyListeners = new Set<() => void>();

export function loadAutoWorktreePolicy(): AutoWorktreePolicy {
  try {
    const saved = localStorage.getItem(POLICY_KEY);
    if (saved === "always" || saved === "never") return saved;
  } catch {
    // Storage can be unavailable; the default still works.
  }
  return "smart";
}

export function saveAutoWorktreePolicy(policy: AutoWorktreePolicy) {
  try {
    localStorage.setItem(POLICY_KEY, policy);
  } catch {
    // Keeps working for this run through the listeners below.
  }
  policyListeners.forEach((listener) => listener());
}

export function subscribeAutoWorktreePolicy(listener: () => void) {
  policyListeners.add(listener);
  return () => {
    policyListeners.delete(listener);
  };
}

/** Why a new session should get a worktree, or null to stay in the checkout. */
export function decideAutoWorktree(input: {
  policy: AutoWorktreePolicy;
  otherSessionBusy: boolean;
  /** Null until the check has answered. */
  dirty: boolean | null;
}): AutoWorktreeReason | null {
  if (input.policy === "never") return null;
  if (input.policy === "always") return "always";
  if (input.otherSessionBusy) return "busy";
  return input.dirty ? "dirty" : null;
}

export function autoWorktreeReasonText(reason: AutoWorktreeReason): string {
  if (reason === "busy") return "Another session is working in this project";
  if (reason === "dirty") return "This project has uncommitted changes";
  return "Your setting gives every new session a worktree";
}

function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, SLUG_LENGTH)
    .trim()
    .replace(/ +/g, "-");
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase();
}

/** `mc/fix-the-login-a1b2c3`, named from what the session was asked to do. */
export function sessionWorktreeBranchName(
  text: string,
  id: string = crypto.randomUUID(),
): string {
  const slug = slugify(text);
  const token = shortId(id);
  return slug && token
    ? `mc/${slug}-${token}`
    : temporaryWorktreeBranchName(id);
}

/** Keeps a branch's short id when a better name for it arrives. */
export function renamedWorktreeBranch(
  named: string,
  current: string | null | undefined,
): string {
  const token = current?.match(/-([a-z0-9]{6})$/)?.[1];
  return token && !named.endsWith(`-${token}`) ? `${named}-${token}` : named;
}

/** The checkout a path belongs to, when the listing has one. */
export function checkoutDirty(
  cwd: string,
  trees: readonly { path: string; dirty: boolean | null }[],
): boolean | null {
  const owners = trees
    .filter((tree) => isEqualOrInside(cwd, tree.path))
    .sort((a, b) => b.path.length - a.path.length);
  return owners[0]?.dirty ?? null;
}

// Only the fields the decision needs, so the store stays cheap to publish.
type BusySession = { id: string; cwd: string; busy?: boolean };

let busyProjects: ReadonlyMap<string, readonly string[]> = new Map();
let busyKey = "";
const busyListeners = new Set<() => void>();

/** App publishes on every session change; listeners only hear real changes. */
export function publishBusySessions(sessions: readonly BusySession[]) {
  const next = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.busy) continue;
    const key = pathKey(session.cwd);
    next.set(key, [...(next.get(key) ?? []), session.id]);
  }
  const nextKey = JSON.stringify([...next]);
  if (nextKey === busyKey) return;
  busyKey = nextKey;
  busyProjects = next;
  busyListeners.forEach((listener) => listener());
}

export function subscribeBusySessions(listener: () => void) {
  busyListeners.add(listener);
  return () => {
    busyListeners.delete(listener);
  };
}

export function otherSessionBusy(sessionId: string, cwd: string): boolean {
  return (busyProjects.get(pathKey(cwd)) ?? []).some((id) => id !== sessionId);
}

// What the person chose or the app picked for a draft, per session and project.
const userChoices = new Set<string>();
const autoPicks = new Map<string, AutoWorktreeReason>();
const pickListeners = new Set<() => void>();
let pickVersion = 0;

const draftKey = (sessionId: string, cwd: string) =>
  `${sessionId}\0${pathKey(cwd)}`;

function picksChanged() {
  pickVersion++;
  pickListeners.forEach((listener) => listener());
}

export function subscribeAutoPicks(listener: () => void) {
  pickListeners.add(listener);
  return () => {
    pickListeners.delete(listener);
  };
}

export const autoPicksVersion = () => pickVersion;

export function noteUserWorkspaceChoice(sessionId: string, cwd: string) {
  userChoices.add(draftKey(sessionId, cwd));
  if (autoPicks.delete(draftKey(sessionId, cwd))) picksChanged();
}

export const userChoseWorkspace = (sessionId: string, cwd: string) =>
  userChoices.has(draftKey(sessionId, cwd));

export function noteAutoPick(
  sessionId: string,
  cwd: string,
  reason: AutoWorktreeReason,
) {
  autoPicks.set(draftKey(sessionId, cwd), reason);
  picksChanged();
}

export const autoPickReason = (sessionId: string, cwd: string) =>
  autoPicks.get(draftKey(sessionId, cwd)) ?? null;

export function coachSeen(): boolean {
  try {
    return localStorage.getItem(COACH_KEY) === "1";
  } catch {
    return true;
  }
}

export function markCoachSeen() {
  try {
    localStorage.setItem(COACH_KEY, "1");
  } catch {
    // Without storage the card can come back next run; nothing breaks.
  }
  picksChanged();
}

export function resetAutoWorktreeForTests() {
  userChoices.clear();
  autoPicks.clear();
  busyProjects = new Map();
  busyKey = "";
}

/** App registers its removal flow, which stops agents and detaches sessions. */
type RemoveHandler = (
  cwd: string,
  path: string,
  force: boolean,
  keepSessions?: boolean,
) => Promise<unknown>;

let removeHandler: RemoveHandler | null = null;

export function registerWorktreeRemover(handler: RemoveHandler | null) {
  removeHandler = handler;
}

export function removeSessionWorktree(cwd: string, path: string) {
  if (!removeHandler) {
    return Promise.reject(new Error("Worktree removal is not available here."));
  }
  return removeHandler(cwd, path, false, true);
}
