/**
 * Fork feature: the chats a Mono has set aside for a fresh one. A Mono's chat
 * lives in the home folder, so no project's Archived group lists it; the Mono's
 * settings do, from this list.
 */
export type PastConversation = {
  id: string;
  title: string;
  at: number;
};

const KEY = "monocode.fork.monoPastConversations";
const MAX_PER_MONO = 50;

function readAll(): Record<string, PastConversation[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved)
      ? saved
      : {};
  } catch {
    return {};
  }
}

/** Newest first. */
export function pastConversations(monoId: string): PastConversation[] {
  const list = readAll()[monoId];
  return Array.isArray(list) ? list : [];
}

export function rememberPastConversation(
  monoId: string,
  past: PastConversation,
): void {
  const all = readAll();
  const rest = (Array.isArray(all[monoId]) ? all[monoId] : []).filter(
    (entry) => entry.id !== past.id,
  );
  all[monoId] = [past, ...rest].slice(0, MAX_PER_MONO);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage blocked or full: search still finds the archived chat.
  }
}
