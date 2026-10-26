import { newSession, type RuntimeMode, type Session } from "../../sessions/model/session";
import {
  closeLeaf,
  leafIds,
  newTab,
  type WorkspaceTab,
} from "../../workspace/model/layout";
import { workspaceTabCwd } from "../../workspace/model/workspaceTabGroups";
import { sameProjectPath } from "../../projects/model/recents";
import {
  findMono,
  isMonoSession,
  monoForSession,
  saveMonoSessionId,
} from "./mono";
import { forgetAgentContext } from "./monoFiles";
import { forgetMonoRotation } from "./monoRotation";

const openingMonos = new Map<string, Promise<Session | undefined>>();

/**
 * Load the Mono's conversation without opening or replacing a workspace tab.
 * A new one uses the home folder and Auto permissions unless its creator
 * supplies a stricter mode. No single project is its own.
 */
export function ensureMonoSession(
  monoId: string,
  host: {
    home(): Promise<string>;
    load(id: string): Promise<Session | null | undefined>;
    create(cwd: string): Session;
    /** Operator-created Monos keep the source turn's permissions. */
    runtimeMode?: RuntimeMode;
    add(session: Session): void;
  },
): Promise<Session | undefined> {
  const pending = openingMonos.get(monoId);
  if (pending) return pending;
  const opening = loadMonoSession(monoId, host).finally(() => {
    if (openingMonos.get(monoId) === opening) openingMonos.delete(monoId);
  });
  openingMonos.set(monoId, opening);
  return opening;
}

async function loadMonoSession(
  monoId: string,
  host: Parameters<typeof ensureMonoSession>[1],
): Promise<Session | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const mono = findMono(monoId);
    if (!mono) return undefined;
    const sessionId = mono.sessionId;
    if (sessionId) {
      const existing = await host.load(sessionId);
      const current = findMono(monoId);
      if (!current) return undefined;
      if (current.sessionId !== sessionId) continue;
      if (existing) return existing;
    }
    const home = await host.home();
    const current = findMono(monoId);
    if (!current) return undefined;
    // A reset or another opener may have assigned the replacement meanwhile.
    if (current.sessionId !== sessionId) continue;
    const session: Session = { ...host.create(home), runtimeMode: host.runtimeMode ?? "auto" };
    saveMonoSessionId(monoId, session.id);
    host.add(session);
    return session;
  }
  throw new Error("The Mono conversation kept changing during initialization; retry configuration");
}

/** Quiet configuration must survive its window closing before the first turn. */
export async function ensurePersistedMonoSession(
  monoId: string,
  host: Parameters<typeof ensureMonoSession>[1] & {
    saved(id: string): Promise<Session | null>;
    persist(session: Session): Promise<{ id: string } | null>;
  },
): Promise<Session> {
  const currentMono = () => {
    const mono = findMono(monoId);
    if (!mono) throw new Error("The Mono was removed before its conversation could be initialized");
    return mono;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const sessionId = currentMono().sessionId;
    if (sessionId) {
      const saved = await host.saved(sessionId);
      if (currentMono().sessionId !== sessionId) continue;
      // An existing conversation may be active in another window. Do not
      // claim it or rewrite that window's transcript just to configure a Mono.
      if (saved?.id === sessionId) return saved;
    }
    const session = await ensureMonoSession(monoId, host);
    const current = currentMono();
    if (!session || current.sessionId !== session.id) continue;
    const saved = await host.persist(session);
    if (currentMono().sessionId !== session.id) continue;
    if (!saved || saved.id !== session.id) {
      throw new Error("The Mono conversation could not be saved; retry configuration before closing this window");
    }
    return session;
  }
  throw new Error("The Mono conversation kept changing while saving; retry configuration");
}

/** Reset only the Mono's chat, keeping its identity, habits and memory. */
export async function resetMonoSession(
  current: Session,
  host: {
    stop(id: string): Promise<Session | undefined>;
    remove(session: Session): Promise<void>;
    replace(session: Session): void;
  },
): Promise<Session> {
  const monoId = monoForSession(current.id)?.id;
  const stopped = (await host.stop(current.id)) ?? current;
  const fresh = newSession(
    stopped.harness,
    stopped.cwd,
    stopped.model,
    stopped.runtimeMode,
    stopped.modelSettings,
  );
  // A failed deletion must leave the original conversation selected.
  await host.remove(stopped);
  forgetAgentContext(current.id);
  forgetMonoRotation(current.id);
  if (monoId) saveMonoSessionId(monoId, fresh.id);
  host.replace(fresh);
  return fresh;
}

/** Migrate the earlier agent tabs into a separate view, keeping ordinary panes. */
export function detachMonoTabs(
  tabs: WorkspaceTab[],
  sessions: Session[],
  activeTabId: string,
  fallbackCwd: string,
  createSession: (cwd: string) => Session,
) {
  let changed = false;
  const removedProjects = new Set<string>();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const agentViewId =
    activeTab && isMonoSession(activeTab.focusedId)
      ? activeTab.focusedId
      : undefined;
  const regularTabs: WorkspaceTab[] = [];
  for (const tab of tabs) {
    const agentIds = leafIds(tab.layout).filter(isMonoSession);
    if (agentIds.length === 0) {
      regularTabs.push(tab);
      continue;
    }
    changed = true;
    const cwd = workspaceTabCwd(tab, sessions) ?? fallbackCwd;
    let remaining: WorkspaceTab | null = tab;
    for (const id of agentIds) {
      if (remaining) remaining = closeLeaf(remaining, id);
    }
    if (remaining) regularTabs.push(remaining);
    else removedProjects.add(cwd);
  }
  if (!changed) return undefined;

  const addedSessions: Session[] = [];
  for (const cwd of removedProjects) {
    if (
      regularTabs.some((tab) => {
        const project = workspaceTabCwd(tab, sessions);
        return project && sameProjectPath(project, cwd);
      })
    )
      continue;
    const session = createSession(cwd);
    addedSessions.push(session);
    regularTabs.push(newTab(session.id));
  }
  const activeCwd = activeTab
    ? (workspaceTabCwd(activeTab, sessions) ?? fallbackCwd)
    : fallbackCwd;
  const allSessions = [...sessions, ...addedSessions];
  const nextActive =
    regularTabs.find((tab) => tab.id === activeTabId) ??
    regularTabs.find((tab) => {
      const cwd = workspaceTabCwd(tab, allSessions);
      return cwd && sameProjectPath(cwd, activeCwd);
    }) ??
    regularTabs[0];
  return {
    tabs: regularTabs,
    addedSessions,
    activeTabId: nextActive.id,
    agentViewId,
  };
}
