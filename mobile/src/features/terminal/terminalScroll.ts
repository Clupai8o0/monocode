/**
 * Where each shell was left scrolled back to, kept across leaving the screen.
 * By terminal id, so a new shell starts at its end. A shell left at its end has
 * no entry, and follows its output again.
 */
const saved = new Map<string, number>();
const MAX_SAVED = 16;

export function rememberTerminalScroll(terminalId: string, y: number | null) {
  saved.delete(terminalId);
  if (y === null) return;
  saved.set(terminalId, y);
  for (const oldest of saved.keys()) {
    if (saved.size <= MAX_SAVED) break;
    saved.delete(oldest);
  }
}

export function savedTerminalScroll(terminalId: string): number | null {
  return saved.get(terminalId) ?? null;
}

/**
 * History comes back in pieces, so the place may not exist yet. Go as far as
 * there is, and finish once the content reaches it.
 */
export function restoreTarget(want: number, contentHeight: number, viewport: number) {
  const furthest = Math.max(0, contentHeight - viewport);
  return { y: Math.min(want, furthest), done: furthest >= want };
}
