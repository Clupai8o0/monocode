import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

type NativeLink = {
  execute(input: string): Promise<string>;
  nativeTranscriptVersion?: number;
};
const module = requireOptionalNativeModule<NativeLink>("MonocodeLink");
// Older development builds and Android retain the existing transcript.
export const hasNativeTranscript =
  Platform.OS === "ios" && module?.nativeTranscriptVersion === 1;

export type Identity = { certificate: string; privateKey: string };
export type Address = { host: string; port: number };
export type Desktop = {
  name: string;
  fingerprint: string;
  addresses: Address[];
  deviceId: string;
  /** A machine's MonoCode host reached over HTTPS (e.g. tailscale serve),
   *  instead of a desktop over QUIC. */
  host?: { url: string };
};
export type Pairing = {
  desktop: Desktop;
  identity: Identity;
  /** The host's device credential, with `desktop.host`. */
  token?: string;
};

export async function nativeCall<T>(input: object): Promise<T> {
  if (!module)
    throw new Error("Rebuild the mobile app to enable desktop connections.");
  const response = JSON.parse(await module.execute(JSON.stringify(input)));
  if (!response.ok)
    throw new Error(response.error ?? "Desktop connection failed");
  return response.result as T;
}
/** How long a host request may take; a watch poll holds for up to 15 s. */
const HOST_TIMEOUT_MS = 25_000;
async function hostCall<T>(
  pairing: Pairing,
  method: string,
  params: object,
  id = makeCommandId(),
  timeoutMs = HOST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${pairing.desktop.host!.url}/mobile`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pairing.token ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, id, method, params }),
      signal: controller.signal,
    });
  } catch {
    throw new Error(`Couldn't reach ${pairing.desktop.name}`);
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => null);
  if (!body || !body.ok)
    throw new Error(body?.error ?? `${pairing.desktop.name} answered ${response.status}`);
  return body.result as T;
}
/** Host watches by the negative IDs handed out for them, beside native ones. */
const hostWatches = new Map<number, { pairing: Pairing; watchId: number }>();
let nextHostWatch = -1;

export function request<T>(
  pairing: Pairing,
  method: string,
  params: object = {},
  id = makeCommandId(),
  /** Host pairings only: how long to wait instead of the default. */
  timeoutMs?: number,
): Promise<T> {
  if (pairing.desktop.host)
    return hostCall<T>(pairing, method, params, id, timeoutMs);
  return nativeCall({
    operation: "exchange",
    identity: pairing.identity,
    pin: pairing.desktop.fingerprint,
    addresses: pairing.desktop.addresses,
    request: { version: 1, id, method, params },
  });
}
/**
 * Opens a watch: the desktop keeps the request's stream open and writes each
 * change to it. Pull them with `nextUpdates`; `closeWatch` stops it.
 */
export async function openWatch(
  pairing: Pairing,
  method: string,
  params: object,
): Promise<number> {
  if (pairing.desktop.host) {
    const { watchId } = await hostCall<{ watchId: number }>(pairing, method, params);
    const id = nextHostWatch--;
    hostWatches.set(id, { pairing, watchId });
    return id;
  }
  const { watchId } = await nativeCall<{ watchId: number }>({
    operation: "watch",
    identity: pairing.identity,
    pin: pairing.desktop.fingerprint,
    addresses: pairing.desktop.addresses,
    request: { version: 1, id: makeCommandId(), method, params },
  });
  return watchId;
}
/** The updates that arrived, waiting up to `timeoutMs` for the first; throws once the watch ended. */
export async function nextUpdates<T>(
  watchId: number,
  timeoutMs: number,
): Promise<T[]> {
  const host = hostWatches.get(watchId);
  if (host) {
    try {
      const { updates } = await hostCall<{ updates: T[] }>(
        host.pairing,
        "watch.next",
        { watchId: host.watchId, timeoutMs },
      );
      return updates;
    } catch (error) {
      // A lost reply may have carried a frame; the phone reopens from scratch.
      hostWatches.delete(watchId);
      throw error;
    }
  }
  const { updates } = await nativeCall<{ updates: T[] }>({
    operation: "next",
    watchId,
    timeoutMs,
  });
  return updates;
}
export function closeWatch(watchId: number) {
  const host = hostWatches.get(watchId);
  if (host) {
    hostWatches.delete(watchId);
    return hostCall(host.pairing, "watch.close", { watchId: host.watchId }).catch(() => {});
  }
  return nativeCall({ operation: "unwatch", watchId }).catch(() => {});
}
export function makeCommandId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
export { parseHostInvitation, parseInvitation } from "./invitation";
