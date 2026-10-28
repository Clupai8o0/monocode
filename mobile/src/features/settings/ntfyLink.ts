/** The host's ntfy server and topic, as `notify.config` gives them. */
export type PushConfig = { server: string; topic: string };

const NTFY_PACKAGE = "io.heckel.ntfy";
const NTFY_APP_STORE_URL = "https://apps.apple.com/us/app/ntfy/id1625396347";

/**
 * The ntfy app's store page for this platform (`Platform.OS`): the App Store on
 * iOS; on Android the Play Store app first, then the Play web page.
 */
export function ntfyStoreUrls(os: string): string[]
{
  if (os === "ios") {
    return [NTFY_APP_STORE_URL];
  }
  return [
    `market://details?id=${NTFY_PACKAGE}`,
    `https://play.google.com/store/apps/details?id=${NTFY_PACKAGE}`,
  ];
}

/**
 * The ntfy app's subscribe link, as ntfy documents it: `ntfy://<host>/<topic>`,
 * with a non-default port kept and `?secure=false` for a plain http server.
 * Null for an address that is not http(s).
 */
export function ntfySubscribeLink(config: PushConfig): string | null {
  let url: URL;
  try {
    url = new URL(config.server);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname.replace(/\/+$/, "");
  const link = `ntfy://${url.host}${path}/${encodeURIComponent(config.topic)}`;
  return url.protocol === "http:" ? `${link}?secure=false` : link;
}
