import type { Element, ElementContent, Root } from "hast";

/**
 * Fork feature: a `- [ ]` box in a reply is an option to pick. A box is known by
 * its reply's block id and its own text, and stays ticked across restarts, as
 * a record of what was picked. `off` is how a `- [x]` box stays clear.
 */
export type TaskPick = "ticked" | "off";
export type BlockPicks = Readonly<Record<string, TaskPick>>;

const STORAGE_KEY = "monocode.fork.taskPicks";
const MAX_BLOCKS = 200;

let store: Record<string, BlockPicks> | null = null;
/** The saved copy is behind this run's, so it must not be read back. */
let writeFailed = false;
const listeners = new Set<() => void>();

function readSaved(): Record<string, BlockPicks> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null;
  }
}

function loadStore(): Record<string, BlockPicks> {
  store ??= readSaved() ?? {};
  return store;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function updateBlock(
  blockId: string,
  change: (picks: BlockPicks | undefined) => BlockPicks,
): void {
  // Read again first, so a tick saved by another window is not written over.
  // Re-inserted last, so the cap drops the blocks left alone the longest.
  const { [blockId]: previous, ...rest } =
    (writeFailed ? null : readSaved()) ?? loadStore();
  const ids = Object.keys(rest);
  for (const id of ids.slice(0, Math.max(0, ids.length + 1 - MAX_BLOCKS))) {
    delete rest[id];
  }
  store = { ...rest, [blockId]: change(previous) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    writeFailed = false;
  } catch {
    // Storage blocked or full: the ticks just won't outlive this run.
    writeFailed = true;
  }
  notify();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return;
  store = null;
  notify();
}

export function subscribeTaskPicks(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function blockPicks(blockId: string): BlockPicks | undefined {
  return loadStore()[blockId];
}

/**
 * Names one box in a reply. Its Markdown block and its place among same-worded
 * boxes in that block keep two "Review" items under different headings apart.
 */
export function pickKey(
  markdownBlock: number,
  occurrence: number,
  label: string,
): string {
  return `${markdownBlock}.${occurrence} ${label}`;
}

export function setTaskPick(
  blockId: string,
  key: string,
  ticked: boolean,
): void {
  updateBlock(blockId, (picks) => ({
    ...picks,
    [key]: ticked ? "ticked" : "off",
  }));
}

function isElement(node: ElementContent): node is Element {
  return node.type === "element";
}

function isTaskBox(node: Element): boolean {
  return node.tagName === "input" && node.properties.type === "checkbox";
}

/** A list item's own text, without the lists nested under it. */
function ownText(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (!isElement(node) || node.tagName === "ul" || node.tagName === "ol") {
    return "";
  }
  return node.children.map(ownText).join("");
}

function taskBoxOf(item: Element): Element | undefined {
  for (const child of item.children.filter(isElement)) {
    if (isTaskBox(child)) return child;
    if (child.tagName === "p") {
      const box = child.children.filter(isElement).find(isTaskBox);
      if (box) return box;
    }
  }
  return undefined;
}

function stampTaskBoxes(node: Root | Element, seen: Map<string, number>): void {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "li") {
      const box = taskBoxOf(child);
      const label = ownText(child).replace(/\s+/g, " ").trim();
      if (box && label) {
        const occurrence = seen.get(label) ?? 0;
        seen.set(label, occurrence + 1);
        box.properties.dataTaskLabel = label;
        box.properties.dataTaskOccurrence = occurrence;
      }
    }
    stampTaskBoxes(child, seen);
  }
}

/** Gives each task box its list item's text, which React cannot see from the box. */
export function rehypeTaskLabels() {
  return (tree: Root) => stampTaskBoxes(tree, new Map());
}
