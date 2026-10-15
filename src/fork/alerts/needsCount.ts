/**
 * Fork feature: how many sessions need you (an approval or a question), for
 * the window title. The Dock badge already shows the same number; the title
 * puts it where Mission Control, the Window menu and Cmd-Tab can see it.
 */

let count = 0;
const listeners = new Set<() => void>();

export function setNeedsCount(next: number) {
  if (next === count) {
    return;
  }
  count = next;
  for (const listener of listeners) {
    listener();
  }
}

export function needsCount(): number {
  return count;
}

export function subscribeNeedsCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** "2 need you · app — MonoCode"; the plain title when nothing waits. */
export function titleWithNeeds(title: string, n: number): string {
  if (n <= 0) {
    return title;
  }
  return `${n} need${n === 1 ? "s" : ""} you · ${title}`;
}
