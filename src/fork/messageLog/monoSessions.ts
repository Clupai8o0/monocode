import { knownRemoteMachine } from "../../features/connections/model/connections";
import { parseRemotePath } from "../../features/connections/model/remoteProjects";
import type { MonoSessionRef } from "./messageLogModel";

/**
 * Fork: MonoCode's sessions as the message log needs them: which Claude
 * session each runs, and on which machine. A session on a machine that is
 * not known yet is left out until the next change.
 */
export function monoSessionRefs(
  sessions: readonly { id: string; cwd: string; providerSessionId?: string }[],
): MonoSessionRef[] {
  return sessions.flatMap((session) => {
    if (!session.providerSessionId) {
      return [];
    }
    const remote = parseRemotePath(session.cwd);
    if (!remote) {
      return [{ id: session.id, providerSessionId: session.providerSessionId, placeId: "local" }];
    }
    const machine = knownRemoteMachine(remote.environmentId);
    return machine ? [{ id: session.id, providerSessionId: session.providerSessionId, placeId: machine.id }] : [];
  });
}
