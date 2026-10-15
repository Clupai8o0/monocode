import { emit } from "@tauri-apps/api/event";
import type { Block } from "../../features/sessions/model/session";
import { NOTIFICATION_CLICK_EVENT } from "../../features/notifications/model/notifications";
import { sessionIdForPid } from "../../integrations/harness/core/child";
import { PeerMessageCard } from "./PeerMessageCard";
import { parsePeerMessage, peerPid } from "./peerMessage";
import { isUrgentPeer } from "./peerStats";

/**
 * A peer message in the transcript. "Open session" shows only when the sender
 * is a session MonoCode itself runs (its Claude process id is one of ours);
 * it goes through the notification-click event, which every window hears and
 * only the one holding that session acts on.
 */
export function PeerMessageBlock({
  block,
  embedded = false,
}: {
  block: Block;
  embedded?: boolean;
}) {
  const message = parsePeerMessage(block.text) ?? {
    name: "Session",
    body: block.text,
  };
  const pid = peerPid(message.from);
  const sessionId = pid == null ? undefined : sessionIdForPid(pid);
  return (
    <div className={embedded ? "py-2" : "px-4 py-2"}>
      <PeerMessageCard
        message={message}
        at={message.at}
        urgent={isUrgentPeer(message.body)}
        onOpen={
          sessionId
            ? () => void emit(NOTIFICATION_CLICK_EVENT, sessionId)
            : undefined
        }
      />
    </div>
  );
}
