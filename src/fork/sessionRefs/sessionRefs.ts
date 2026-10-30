import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listSessionsByProject } from "../../features/sessions/data/sessionStore";
import type {
  ExternalSession,
  ExternalSessionsTarget,
} from "../externalSessions/externalSessionsModel";
import {
  FORK_EXTERNAL_SESSIONS,
  knownLocalProjectPaths,
  matchProjects,
  remoteExternalRows,
  subscribeExternalRows,
} from "../externalSessions/externalSessionsStore";
import { OPEN_SESSION_EVENT } from "../workspaces/workspaces";

/**
 * Fork feature: sessions talk about each other by name ("monocode-68") or id.
 * A reply's mention of a session this app knows becomes a link that opens it.
 * Every name-shaped word is marked when the reply renders; whether it links is
 * looked up live, so a session seen later needs no second Markdown parse.
 */

export type SessionRef = {
  session: ExternalSession;
  /** The machine it runs on; absent on this Mac. */
  machineId?: string;
};

// ---- finding mentions ----

/** Words joined by hyphens, as session names and UUIDs are, or a short id. */
const MENTION =
  /(?<![\w./-])(?:[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+|[0-9a-f]{8})(?!\.?[\w/-])/g;

/** Cuts text into plain runs and `{mention}` pieces, in order. */
export function splitMentions(text: string): (string | { mention: string })[] {
  const out: (string | { mention: string })[] = [];
  let at = 0;
  for (const match of text.matchAll(MENTION)) {
    if (match.index > at) {
      out.push(text.slice(at, match.index));
    }
    out.push({ mention: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) {
    out.push(text.slice(at));
  }
  return out;
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function mentionNode(mention: string): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: { dataSessionRef: mention },
    children: [{ type: "text", value: mention }],
  };
}

const NOT_PROSE = new Set(["a", "button", "pre", "script", "style"]);

function markMentions(node: HastNode): void {
  if (!node.children) {
    return;
  }
  if (node.tagName === "code") {
    // A command mentions all sorts of things; only a lone name is a reference.
    const only = node.children.length === 1 ? node.children[0] : undefined;
    const pieces = only?.type === "text" ? splitMentions(only.value ?? "") : [];
    const lone = pieces.length === 1 ? pieces[0] : undefined;
    if (lone && typeof lone !== "string") {
      node.children = [mentionNode(lone.mention)];
    }
    return;
  }
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text") {
      if (!NOT_PROSE.has(child.tagName ?? "")) {
        markMentions(child);
      }
      return [child];
    }
    return splitMentions(child.value ?? "").map((piece) =>
      typeof piece === "string"
        ? { type: "text", value: piece }
        : mentionNode(piece.mention),
    );
  });
}

export function rehypeSessionRefs() {
  return (tree: HastNode) => markMentions(tree);
}

// ---- who is known ----

const STORAGE_KEY = "monocode.fork.sessionRefs";
const MAX_REMEMBERED = 300;
const SCAN_MS = 60_000;

/** A session that has since ended still opens, so names outlive the registry. */
let remembered: SessionRef[] | null = null;
let local: SessionRef[] = [];
let index = new Map<string, SessionRef>();
let indexKey = "";
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let stopRows: (() => void) | null = null;
let scanning = false;

function loadRemembered(): SessionRef[] {
  if (remembered) {
    return remembered;
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    remembered = Array.isArray(parsed)
      ? parsed.filter((ref) => typeof ref?.session?.id === "string")
      : [];
  } catch {
    remembered = [];
  }
  return remembered;
}

function saveRemembered(refs: SessionRef[]): void {
  remembered = refs.slice(-MAX_REMEMBERED);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(remembered));
  } catch {
    // Storage full or blocked: names last for this run.
  }
}

function startedAt(ref: SessionRef): number {
  return ref.session.startedAt ?? ref.session.updatedAt ?? 0;
}

/**
 * Who a word means. Later entries win: a live session over one that handed
 * over, this Mac over a machine, and the newest of two with one name.
 */
export function buildIndex(
  refs: readonly SessionRef[],
): Map<string, SessionRef> {
  const rank = (ref: SessionRef) =>
    (ref.session.state === "handed-over" ? 0 : 2) + (ref.machineId ? 0 : 1);
  const ordered = [...refs].sort(
    (a, b) => rank(a) - rank(b) || startedAt(a) - startedAt(b),
  );
  const out = new Map<string, SessionRef>();
  for (const ref of ordered) {
    const { id, name } = ref.session;
    if (id.startsWith("handoff:")) {
      if (name) {
        out.set(name, ref);
      }
      continue;
    }
    out.set(id, ref);
    out.set(id.slice(0, 8), ref);
    if (name) {
      out.set(name, ref);
    }
  }
  return out;
}

function rebuild(): void {
  const remote = FORK_EXTERNAL_SESSIONS ? remoteExternalRows() : [];
  const live = [...local, ...remote];
  const seen = new Set(live.map((ref) => ref.session.id));
  const kept = loadRemembered().filter((ref) => !seen.has(ref.session.id));
  // Whoever is around now wins over anyone only remembered.
  const next = new Map([...buildIndex(kept), ...buildIndex(live)]);
  const key = [...next]
    .map(([word, ref]) => `${word}\0${refKey(ref)}`)
    .join("\n");
  // Fresh copies either way, for a state that changed under the same name.
  index = next;
  if (key === indexKey) {
    return;
  }
  indexKey = key;
  saveRemembered([...kept, ...live]);
  for (const listener of listeners) {
    listener();
  }
}

async function scanLocal(): Promise<void> {
  if (scanning || (typeof document !== "undefined" && document.hidden)) {
    return;
  }
  scanning = true;
  try {
    const result = await invoke<{ sessions?: ExternalSession[] }>(
      "fork_external_sessions_list",
      { projects: matchProjects([], knownLocalProjectPaths()), only: null },
    );
    local = (result?.sessions ?? []).map((session) => ({ session }));
    rebuild();
  } catch {
    // The last good list stands; the next scan tries again.
  } finally {
    scanning = false;
  }
}

export function subscribeSessionRefs(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && FORK_EXTERNAL_SESSIONS) {
    rebuild();
    stopRows = subscribeExternalRows(rebuild);
    void scanLocal();
    timer = setInterval(() => void scanLocal(), SCAN_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopRows?.();
      stopRows = null;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

export function refKey(ref: SessionRef | undefined): string {
  // State and project too: an open viewer goes live, and a link reads the right place.
  return ref
    ? [
        ref.machineId ?? "",
        ref.session.id,
        ref.session.state,
        ref.session.projectId,
      ].join("\0")
    : "";
}

export function lookupSessionRef(word: string): SessionRef | undefined {
  return index.get(word);
}

// ---- opening ----

/** Where the viewer reads a session MonoCode did not start. */
export function refTarget(ref: SessionRef): ExternalSessionsTarget {
  return ref.machineId
    ? {
        kind: "remote",
        machineId: ref.machineId,
        projectId: ref.session.projectId,
      }
    : {
        kind: "local",
        projectId: ref.session.projectId,
        cwd: ref.session.projectId,
      };
}

/** The MonoCode session running this agent session, if this app started it. */
export async function ownSessionFor(
  session: ExternalSession,
): Promise<string | undefined> {
  const find = async (cwd: string) =>
    (await listSessionsByProject(cwd)).find(
      (entry) =>
        entry.id === session.id || entry.providerSessionId === session.id,
    )?.id;
  try {
    const here = await find(session.cwd);
    if (here) {
      return here;
    }
    const rest = knownLocalProjectPaths().filter(
      (path) => path !== session.cwd,
    );
    const found = await Promise.all([...new Set(rest)].map(find));
    return found.find(Boolean);
  } catch {
    return undefined;
  }
}

/** Opens it through the same path as a notification. */
export function openOwnSession(sessionId: string): Promise<void> {
  return emitTo(getCurrentWindow().label, OPEN_SESSION_EVENT, sessionId);
}

/** Tests only. */
export function resetSessionRefsForTest(): void {
  remembered = null;
  local = [];
  index = new Map();
  indexKey = "";
}
