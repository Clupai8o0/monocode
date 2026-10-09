/**
 * Fork feature: the side-checklist sidebar.
 *
 * The side-checklist Claude Code mod gives Claude a `checklist` tool for steps
 * the person must carry out. Each call is kept on its tool block (`block.checklist`),
 * so the list is rebuilt from the transcript and survives reloads. The fold below
 * mirrors the mod's own rules so the sidebar matches the terminal pane.
 */

export type ChecklistItem = {
  text: string;
  done: boolean;
  who?: string;
  by?: string;
};

export type Checklist = {
  title: string;
  items: ChecklistItem[];
};

/** One checklist tool call's input, as Claude sent it. */
export type ChecklistOp = Record<string, unknown>;

const DEFAULT_TITLE = "Checklist";

/** The mod's tool, as an MCP name (`mcp__side-checklist__checklist`) or bare. */
export function isChecklistToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "checklist" ||
    (normalized.startsWith("mcp__") && normalized.endsWith("__checklist"))
  );
}

/** Keeps only the fields the fold reads, so a stored op stays small and safe. */
export function sanitizeChecklistOp(value: unknown): ChecklistOp | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.action !== "string") return undefined;
  const op: ChecklistOp = { action: rec.action };
  if (typeof rec.title === "string") op.title = rec.title;
  if (Array.isArray(rec.items)) op.items = rec.items;
  if (Array.isArray(rec.numbers)) op.numbers = rec.numbers;
  if (typeof rec.number === "number") op.number = rec.number;
  return op;
}

function toItems(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((one): ChecklistItem[] => {
    if (typeof one === "string") return [{ text: one, done: false }];
    if (!one || typeof one !== "object") return [];
    const o = one as Record<string, unknown>;
    if (typeof o.text !== "string") return [];
    return [
      {
        text: o.text,
        done: o.done === true,
        ...(typeof o.who === "string" && o.who ? { who: o.who } : {}),
        ...(typeof o.by === "string" && o.by ? { by: o.by } : {}),
      },
    ];
  });
}

/** Applies one call; an invalid call leaves the list unchanged, as the mod does. */
export function applyChecklistOp(list: Checklist, op: ChecklistOp): Checklist {
  const action = op.action;
  if (action === "set") {
    const title =
      typeof op.title === "string" && op.title ? op.title : list.title;
    return { title, items: toItems(op.items) };
  }
  if (action === "add") {
    return { ...list, items: [...list.items, ...toItems(op.items)] };
  }
  if (action === "clear") {
    return { title: DEFAULT_TITLE, items: [] };
  }
  if (action === "check" || action === "uncheck" || action === "remove") {
    const numbers = Array.isArray(op.numbers)
      ? op.numbers
      : typeof op.number === "number"
        ? [op.number]
        : [];
    const valid =
      numbers.length > 0 &&
      numbers.every(
        (n) =>
          typeof n === "number" &&
          Number.isInteger(n) &&
          n >= 1 &&
          n <= list.items.length,
      );
    if (!valid) return list;
    const picked = new Set(numbers as number[]);
    if (action === "remove") {
      return { ...list, items: list.items.filter((_, i) => !picked.has(i + 1)) };
    }
    return {
      ...list,
      items: list.items.map((item, i) =>
        picked.has(i + 1) ? { ...item, done: action === "check" } : item,
      ),
    };
  }
  return list;
}

/**
 * Rebuilds the list from every checklist call in the transcript, in order.
 * A call that failed (denied, or the mod rejected it) changed nothing.
 */
export function checklistFromBlocks(
  blocks: readonly { checklist?: ChecklistOp; tool?: { status?: string } }[],
): Checklist {
  let list: Checklist = { title: DEFAULT_TITLE, items: [] };
  for (const block of blocks) {
    if (!block.checklist || block.tool?.status === "failed") continue;
    list = applyChecklistOp(list, block.checklist);
  }
  return list;
}
