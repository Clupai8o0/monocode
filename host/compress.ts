import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
// Below this a reply fits in one packet anyway; gzip would only add latency.
export const GZIP_MIN_BYTES = 1024;
// Fast enough for 265 KB snapshots, and most of the size win of level 9.
const GZIP_LEVEL = 5;

// RFC 9110 qvalue: 0 to 1 with at most three decimals.
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** Whether an Accept-Encoding header allows gzip (`gzip`, `x-gzip` or `*`, q > 0).
 * A malformed q-value refuses the coding rather than counting as absent. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  let wildcard: boolean | undefined;
  for (const part of value.split(",")) {
    const [token, ...options] = part.toLowerCase().split(";");
    const name = token.trim();
    const q = options
      .map((option) => option.split("=").map((piece) => piece.trim()))
      .find(([key]) => key === "q");
    const allowed = !q || (q.length === 2 && QVALUE.test(q[1]) && Number(q[1]) > 0);
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
