import type { RemoteMachine } from "../../features/connections/model/protocol";
import { FORK_SESSION_MOVE, moveAvailability } from "./sessionMoveModel";
import { moveHost, moveTabToHost, tabMoveFacts } from "./sessionMoveStore";

const PREFIX = "fork-move:";

/** The session menu's items, one per machine it could go to. */
export function moveMenuItems(
  summary: { id: string; harness: string },
  machines: readonly RemoteMachine[],
) {
  if (!FORK_SESSION_MOVE || summary.harness !== "claude") {
    return [];
  }
  const session = moveHost()?.session(summary.id);
  return machines.flatMap((machine) => {
    if (!session) {
      return [
        {
          kind: "item" as const,
          id: `${PREFIX}${machine.id}`,
          label: `Move to ${machine.name}`,
          disabled: true,
          description: "Open the session first",
        },
      ];
    }
    const availability = moveAvailability(tabMoveFacts(session, machine.id, machine.name));
    return availability.show
      ? [
          {
            kind: "item" as const,
            id: `${PREFIX}${machine.id}`,
            label: `Move to ${machine.name}`,
            disabled: Boolean(availability.disabled),
            description: availability.disabled,
          },
        ]
      : [];
  });
}

/** True when the pick was one of these items. */
export function pickMoveItem(id: string, sessionId: string, machines: readonly RemoteMachine[]): boolean {
  if (!id.startsWith(PREFIX)) {
    return false;
  }
  const machine = machines.find((entry) => entry.id === id.slice(PREFIX.length));
  if (machine) {
    moveTabToHost(sessionId, machine.id, machine.name);
  }
  return true;
}
