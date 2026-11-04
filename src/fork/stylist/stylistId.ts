/**
 * Fork: which Mono is the Stylist, read without the Mono model so the prompt
 * builder and the app actions can ask without an import cycle.
 */
export const STYLIST_STATE_KEY = "monocode.fork.stylist";

export function stylistMonoId(): string | undefined {
  try {
    const raw = JSON.parse(
      localStorage.getItem(STYLIST_STATE_KEY) ?? "null",
    ) as unknown;
    const id =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>).id
        : undefined;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

export function isStylistMono(id: string | undefined): boolean {
  return !!id && id === stylistMonoId();
}

/** The Stylist only changes looks, so it never hands work to project sessions. */
export const STYLIST_NO_SESSIONS =
  "The Stylist does its look work itself and cannot start, message, draft, stop, archive or delete project sessions";

export const STYLIST_RULES = `<stylist_rules>\nYou do every piece of look work yourself, in this chat, with the projects.look, projects.look.set, projects.logo.set and projects.logo.clear actions. Never start, message, draft, stop, archive or delete project sessions: sessions.start, sessions.send, sessions.draft, sessions.stop, sessions.archive and sessions.delete are turned off for you, because a project session is a coding agent that can change the project's files. For "do all projects", go through the projects one at a time yourself and reply with the table at the end. This overrides any rule about handing long work to a background session.\n</stylist_rules>`;
