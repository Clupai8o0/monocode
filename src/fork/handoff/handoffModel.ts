/**
 * Fork feature: "Continue from handoff". When a project has
 * `.claude/handoff.md` (written by a session that stopped part-way), the
 * sessions list shows a card with its newest section and a Continue button
 * that opens a new session with the prompt below in the composer, and the
 * project's rail row gets a small tag.
 */

export const HANDOFF_FILE = ".claude/handoff.md";

/** The prompt that picks up from a handoff file, relative to the project. */
export function continuePrompt(path: string = HANDOFF_FILE): string {
  return `Read ${path} and continue from where it left off.`;
}

export const CONTINUE_PROMPT = continuePrompt();

const bare = (path: string) => path.replace(/^\.\//, "");

/** `.claude/handoff.md`, or a named one such as `.claude/handoff-api.md`. */
export function isHandoffFile(path: string): boolean {
  return /^\.claude\/handoff(-[^/]+)?\.md$/.test(bare(path));
}

/**
 * The handoff to show among a project's files: `.claude/handoff.md` first,
 * else the newest `.claude/handoff-*.md`.
 */
export function pickHandoffFile(
  files: { path: string; mtimeMs: number }[],
): string | null {
  const found = files.filter((file) => isHandoffFile(file.path));
  if (found.some((file) => bare(file.path) === HANDOFF_FILE)) {
    return HANDOFF_FILE;
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0] ? bare(found[0].path) : null;
}

export function handoffPath(cwd: string): string | null {
  // Local folders only: a remote project's files are not on this Mac.
  if (!cwd.startsWith("/")) {
    return null;
  }
  return `${cwd.replace(/\/+$/, "")}/${HANDOFF_FILE}`;
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function plain(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * The newest section's heading and its first line, which is how handoffs are
 * written here: the latest "## NOW ..." section goes at the top.
 */
export function summarizeHandoff(text: string): {
  heading: string;
  line: string;
} {
  const lines = text.split("\n");
  let heading = "";
  let line = "";
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const h = /^#{2,6}\s+(.*)$/.exec(trimmed);
    if (h) {
      if (heading) {
        break;
      }
      heading = plain(h[1]);
      continue;
    }
    if (/^#\s/.test(trimmed)) {
      continue;
    }
    if (heading || !line) {
      line = plain(trimmed.replace(/^[-*]\s+/, ""));
      if (heading) {
        break;
      }
    }
  }
  return { heading: clip(heading, 90), line: clip(line, 140) };
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function handoffAge(mtimeMs: number, now: number): string {
  const min = Math.floor(Math.max(0, now - mtimeMs) / 60_000);
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min}m ago`;
  }
  const h = Math.floor(min / 60);
  if (h < 48) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
}
