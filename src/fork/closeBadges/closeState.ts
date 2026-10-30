import { readSession } from "../sessionRead";
import type { Block } from "../../features/sessions/model/session";
import { isMonoSession } from "../../features/monos/model/mono";

/**
 * Fork feature: every session on this Mac ends its work with a "Close:" line
 * (safe / handover ready / not safe). This reads that line from each listed
 * session's last reply, so the sidebar can badge it and close the safe ones.
 */

export type CloseKind = "safe" | "handover" | "unsafe";

export type CloseState = {
  kind: CloseKind;
  /** The handover path, or the reason it is not safe. Empty for plain safe. */
  detail: string;
};

const CLOSE_LINE = /^(?:[-*+]\s+)?close\s*:\s*(.*)$/i;
const UNSAFE = /^not safe to close\b[\s:,-]*(.*)$/i;
const HANDOVER = /^safe to close\s*,?\s*handover ready\b[\s:,-]*(.*)$/i;
const SAFE = /^safe to close\b/i;
/** A reply may end on the close line alone, without the recap's "Close:". */
const BARE_CLOSE_LINE = /^(?:not )?safe to close\s*(?:[:,.]|$)/i;

/** Reads the last "Close:" line of a reply, ignoring markdown bold and code. */
export function parseCloseLine(text: string): CloseState | null {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/[*`_]/g, "").trim();
    const match = CLOSE_LINE.exec(line);
    const bare = i === lines.length - 1 && BARE_CLOSE_LINE.test(line);
    if (!match && !bare) {
      continue;
    }
    const rest = match ? match[1].trim() : line;
    const unsafe = UNSAFE.exec(rest);
    if (unsafe) {
      return { kind: "unsafe", detail: tidy(unsafe[1]) };
    }
    const handover = HANDOVER.exec(rest);
    if (handover) {
      return { kind: "handover", detail: tidy(handover[1]) };
    }
    if (SAFE.test(rest)) {
      return { kind: "safe", detail: "" };
    }
    return null;
  }
  return null;
}

function tidy(value: string): string {
  return value.trim().replace(/[.\s]+$/, "");
}

/**
 * The close state of a transcript: the "Close:" line of the last reply after
 * the user's last message. A newer user message means the work went on, so
 * the old line no longer counts.
 */
export function closeStateOfBlocks(
  blocks: readonly Pick<Block, "role" | "text">[],
): CloseState | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role === "user") {
      return null;
    }
    if (block.role === "assistant" && block.text.trim()) {
      return parseCloseLine(block.text);
    }
  }
  return null;
}

// --- Store -----------------------------------------------------------------

type Entry = { at: number; state: CloseState | null };

const STORAGE_KEY = "monocode.fork.closeStates";
const MAX_ENTRIES = 400;

let entries: Map<string, Entry> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const queue = new Map<string, number>();
let pumping = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function store(): Map<string, Entry> {
  if (entries) {
    return entries;
  }
  entries = new Map();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as [string, Entry][]) : [];
    for (const [id, entry] of parsed) {
      if (typeof id === "string" && typeof entry?.at === "number") {
        entries.set(id, entry);
      }
    }
  } catch {
    // A missing or corrupt cache only means badges are worked out again.
  }
  return entries;
}

function save() {
  if (saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const all = [...store()];
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(all.slice(-MAX_ENTRIES)),
      );
    } catch {
      // Storage full or blocked: the badges still work for this run.
    }
  }, 1000);
}

function emit() {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeCloseStates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function closeStatesVersion(): number {
  return version;
}

/** The cached state, only while it still matches the session's last save. */
export function cachedCloseState(
  sessionId: string,
  updatedAt: number,
): CloseState | null {
  const entry = store().get(sessionId);
  return entry && entry.at === updatedAt ? entry.state : null;
}

export function closeEntry(sessionId: string): Entry | undefined {
  return store().get(sessionId);
}

/** Records a state directly (tests, or a caller that already has the blocks). */
export function setCloseState(
  sessionId: string,
  updatedAt: number,
  state: CloseState | null,
) {
  const map = store();
  map.delete(sessionId);
  map.set(sessionId, { at: updatedAt, state });
  save();
  emit();
}

/**
 * Works out a session's state from its saved transcript, once per save. Reads
 * the row directly rather than through `getSession`, which can write repairs
 * back and would race the live session.
 */
export function requestCloseState(sessionId: string, updatedAt: number) {
  if (isMonoSession(sessionId)) {
    return;
  }
  if (store().get(sessionId)?.at === updatedAt) {
    return;
  }
  queue.set(sessionId, updatedAt);
  void pump();
}

async function pump() {
  if (pumping) {
    return;
  }
  pumping = true;
  try {
    while (queue.size > 0) {
      const [sessionId, updatedAt] = queue.entries().next().value as [
        string,
        number,
      ];
      queue.delete(sessionId);
      if (store().get(sessionId)?.at === updatedAt) {
        continue;
      }
      let record: { blocks?: Block[] } | null;
      try {
        record = await readSession(sessionId, updatedAt);
      } catch {
        // Not cached, so the next save or the next mount tries again.
        continue;
      }
      setCloseState(sessionId, updatedAt, closeStateOfBlocks(record?.blocks ?? []));
    }
  } finally {
    pumping = false;
  }
}
