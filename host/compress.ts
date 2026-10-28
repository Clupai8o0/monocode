import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
// Below this a reply fits in one packet anyway; gzip would only add latency.
export const GZIP_MIN_BYTES = 1024;
// Fast enough for 265 KB snapshots, and most of the size win of level 9.
const GZIP_LEVEL = 5;

/** Whether an Accept-Encoding header allows gzip (`gzip`, `x-gzip` or `*`, q > 0). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  let wildcard: boolean | undefined;
  for (const part of value.split(",")) {
    const [token, ...options] = part.toLowerCase().split(";");
    const name = token.trim();
    const q = options
      .map((option) => option.trim().match(/^q=([0-9.]+)$/)?.[1])
      .find((match) => match !== undefined);
    const allowed = q === undefined || Number(q) > 0;
    if (name === "gzip" || name === "x-gzip") return allowed;
    if (name === "*") wildcard = allowed;
  }
  return wildcard ?? false;
}

/**
 * Ends a JSON reply, gzipped when it is large enough and the client accepts it.
 * Compression runs off the event loop; on failure the reply goes out as is.
 */
export async function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  text: string,
  status = 200,
): Promise<void> {
  const raw = Buffer.from(text, "utf8");
  let packed: Buffer | undefined;
  if (raw.length >= GZIP_MIN_BYTES && acceptsGzip(request.headers["accept-encoding"])) {
    packed = await gzipAsync(raw, { level: GZIP_LEVEL }).catch(() => undefined);
  }
  if (response.destroyed || response.headersSent) return;
  if (packed) {
    response.setHeader("Content-Encoding", "gzip");
    response.setHeader("Vary", "Accept-Encoding");
  }
  response.writeHead(status).end(packed ?? raw);
}
