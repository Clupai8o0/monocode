import type { Session } from "../../features/sessions/model/session";
import { sanitizeChecklistOp } from "./checklist";

/**
 * Stores a checklist call on its tool block. The same call arrives several times
 * while its input streams in; the latest complete input wins.
 */
export function setChecklistOp(
  session: Session,
  callId: string,
  input: Record<string, unknown>,
): Session {
  const op = sanitizeChecklistOp(input);
  if (!op) return session;
  const index = session.blocks.findIndex(
    (block) => block.tool?.callId === callId,
  );
  if (index < 0) return session;
  const prev = session.blocks[index];
  if (JSON.stringify(prev.checklist) === JSON.stringify(op)) return session;
  const blocks = session.blocks.slice();
  blocks[index] = { ...prev, checklist: op };
  return { ...session, blocks };
}
