import { useConnection } from "./ConnectionProvider";
import { connectionLabel } from "./machineLabel";

/** "Vivobook · Linux", "Mac" or "desktop": what this phone is connected to. */
export function useConnectionLabel(): string {
  const { pairing, catalog } = useConnection();
  return connectionLabel(!!pairing?.desktop.host, catalog?.host, pairing?.desktop.name);
}
