/**
 * Fork feature: "who's editing what". Every agent session on this Mac claims
 * the files it edits through the vault's `claims.py` (shared by worktrees and
 * accounts). This file reads its `list --json DIR` output and answers, for one
 * file or folder, which live sessions are editing it and what their status
 * note says. Read-only: MonoCode never claims or releases anything.
 */

export type Claim = {
  /** Path relative to the worktree root. */
  file: string;
  worktree: string;
  session: string;
  /** Session name from its registry, e.g. "monocode-03" or "codex". */
  name: string;
  branch: string;
  /** Last edit, in ms. */
  at: number;
};

export type ClaimNote = {
  text: string;
  worktree: string;
  session: string;
  name: string;
  branch: string;
  /** When the note was written, in ms. */
  notedAt: number;
};

export type ClaimsSnapshot = {
  /** The worktree root the folder sits in (real path). */
  top: string;
  /** The folder's path inside that worktree ("." for the root). */
  here: string;
  claims: Claim[];
  notes: ClaimNote[];
};

/** One session's hold on a file (or on files in a folder). */
export type Holder = {
  session: string;
  name: string;
  branch: string;
  at: number;
  /** Editing in another worktree of the same repo: a merge to come, not a clash. */
  otherTree: boolean;
  worktree: string;
  note: ClaimNote | null;
  /** For a folder: how many of its files this session holds. */
  files: number;
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function seconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : 0;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (r): r is Record<string, unknown> => !!r && typeof r === "object",
      )
    : [];
}

/** Reads `claims.py list --json`; null when the folder isn't in a git repo or the shape is off. */
export function parseClaims(value: unknown): ClaimsSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Record<string, unknown>;
  const top = str(v.top);
  if (!top) {
    return null;
  }
  const claims = records(v.claims)
    .map((c) => ({
      file: str(c.file),
      worktree: str(c.worktree),
      session: str(c.session),
      name: str(c.name) || "?",
      branch: str(c.branch),
      at: seconds(c.at),
    }))
    .filter((c) => c.file && c.worktree && c.session);
  const notes = records(v.notes)
    .map((n) => ({
      text: str(n.text),
      worktree: str(n.worktree),
      session: str(n.session),
      name: str(n.name) || "?",
      branch: str(n.branch),
      notedAt: seconds(n.noted_at) || seconds(n.at),
    }))
    .filter((n) => n.text && n.session);
  return { top, here: str(v.here) || ".", claims, notes };
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function join(base: string, rest: string): string {
  if (!base || base === ".") {
    return rest;
  }
  return rest ? `${base}/${rest}` : base;
}

/**
 * The repo-relative path of `path`, which is written under `root` (the
 * folder the snapshot was asked for, as MonoCode spells it, which may go
 * through a symlink). Null when the path is outside it.
 */
export function relativeTo(
  snapshot: ClaimsSnapshot,
  root: string,
  path: string,
): string | null {
  const r = trimSlash(root);
  const p = trimSlash(path);
  for (const base of [r, trimSlash(snapshot.top)]) {
    if (p === base) {
      return base === r ? snapshot.here : ".";
    }
    if (p.startsWith(`${base}/`)) {
      const rest = p.slice(base.length + 1);
      return base === r ? join(snapshot.here, rest) : rest;
    }
  }
  return null;
}

function noteFor(
  snapshot: ClaimsSnapshot,
  session: string,
  worktree: string,
): ClaimNote | null {
  const mine = snapshot.notes.filter((n) => n.session === session);
  return (
    mine.find((n) => n.worktree === worktree) ??
    mine.sort((a, b) => b.notedAt - a.notedAt)[0] ??
    null
  );
}

/**
 * Live sessions holding `path` (a file) or files under it (a folder), newest
 * edit first, sessions in this worktree before those in others.
 */
export function holdersOf(
  snapshot: ClaimsSnapshot,
  root: string,
  path: string,
  isDir: boolean,
): Holder[] {
  const rel = relativeTo(snapshot, root, path);
  if (rel === null) {
    return [];
  }
  const under = rel === "." ? "" : `${rel}/`;
  const bySession = new Map<string, Holder>();
  for (const c of snapshot.claims) {
    const hit = isDir ? c.file.startsWith(under) : c.file === rel;
    if (!hit) {
      continue;
    }
    const otherTree = c.worktree !== snapshot.top;
    const key = `${c.session}\0${c.worktree}`;
    const seen = bySession.get(key);
    if (seen) {
      seen.files += 1;
      if (c.at > seen.at) {
        seen.at = c.at;
        seen.branch = c.branch;
      }
      continue;
    }
    bySession.set(key, {
      session: c.session,
      name: c.name,
      branch: c.branch,
      at: c.at,
      otherTree,
      worktree: c.worktree,
      note: noteFor(snapshot, c.session, c.worktree),
      files: 1,
    });
  }
  return [...bySession.values()].sort(
    (a, b) => Number(a.otherTree) - Number(b.otherTree) || b.at - a.at,
  );
}

/** "now", "5m", "2h": how long ago, short. */
export function ago(ms: number, now: number): string {
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 1) {
    return "now";
  }
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
}

function agoText(ms: number, now: number): string {
  const short = ago(ms, now);
  return short === "now" ? "just now" : `${short} ago`;
}

export type ClaimTone = "claude" | "codex" | "other";

/** Tag colour by agent, read from the session name the registry gives. */
export function tagTone(name: string): ClaimTone {
  const n = name.toLowerCase();
  if (n.startsWith("codex")) {
    return "codex";
  }
  if (/^(opencode|dsh|kimi|grok|\?)/.test(n) || /^\d+$/.test(n)) {
    return "other";
  }
  return "claude";
}

/** The tag's text: the first holder's name, plus "+N" for the rest. */
export function tagLabel(holders: Holder[]): string {
  if (holders.length === 0) {
    return "";
  }
  return holders.length === 1
    ? holders[0].name
    : `${holders[0].name} +${holders.length - 1}`;
}

/** The tag's hover text: one block per session, its note under it. */
export function tagTooltip(
  holders: Holder[],
  isDir: boolean,
  now: number,
): string {
  return holders
    .map((h) => {
      const what = isDir
        ? `${h.files} file${h.files === 1 ? "" : "s"} in this folder`
        : "this file";
      const where = h.otherTree
        ? ` in another worktree (${h.worktree})`
        : h.branch
          ? ` on ${h.branch}`
          : "";
      const lines = [
        `${h.name} is editing ${what}${where}, last edit ${agoText(h.at, now)}`,
      ];
      if (h.note) {
        lines.push(`Note (${agoText(h.note.notedAt, now)}): ${h.note.text}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}
