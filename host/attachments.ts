import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  openSync,
  closeSync,
  readSync,
  rmSync,
  writeSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Attachment } from "../src/features/sessions/model/session";
import type { RemoteAttachment } from "../src/features/connections/model/protocol";
import type { HostStore } from "./store";

export const MAX_REMOTE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function attachmentPath(store: HostStore, id: string): string {
  if (!UUID.test(id)) throw new Error("Invalid attachment ID");
  return join(store.attachmentDir, id);
}

/** An offset makes a repeated chunk safe when its HTTP response was lost. */
export function writeAttachmentChunk(
  store: HostStore,
  input: Record<string, unknown>,
): { offset: number } {
  const path = attachmentPath(store, String(input.id ?? ""));
  const offset = input.offset;
  const size = input.size;
  const encoded = input.data;
  if (
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    !Number.isSafeInteger(size) ||
    Number(size) < 0 ||
    Number(size) > MAX_REMOTE_ATTACHMENT_BYTES ||
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 ||
    (encoded.length > 0 &&
      (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4))
  )
    throw new Error("Invalid attachment chunk");
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length > MAX_CHUNK_BYTES ||
    Number(offset) + bytes.length > Number(size)
  )
    throw new Error("Invalid attachment chunk size");
  mkdirSync(store.attachmentDir, { recursive: true, mode: 0o700 });
  const fd = openSync(path, Number(offset) === 0 ? "a+" : "r+", 0o600);
  try {
    const length = statSync(path).size;
    if (length === Number(offset)) {
      writeSync(fd, bytes, 0, bytes.length, Number(offset));
    } else if (length >= Number(offset) + bytes.length) {
      const existing = Buffer.alloc(bytes.length);
      readSync(fd, existing, 0, existing.length, Number(offset));
      if (!existing.equals(bytes))
        throw new Error("Attachment retry does not match uploaded bytes");
    } else {
      throw new Error("Attachment chunks are out of order");
    }
    return { offset: Number(offset) + bytes.length };
  } finally {
    closeSync(fd);
  }
}

export function parseRemoteAttachments(value: unknown): RemoteAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("Invalid attachments");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid attachment");
    const v = entry as Record<string, unknown>;
    if (
      !UUID.test(String(v.id ?? "")) ||
      typeof v.name !== "string" ||
      !v.name.trim() ||
      v.name.length > 255 ||
      typeof v.mimeType !== "string" ||
      !v.mimeType.trim() ||
      v.mimeType.length > 128 ||
      !["image", "audio", "file"].includes(String(v.kind)) ||
      !Number.isSafeInteger(v.size) ||
      Number(v.size) < 0 ||
      Number(v.size) > MAX_REMOTE_ATTACHMENT_BYTES
    )
      throw new Error("Invalid attachment");
    return {
      id: v.id as string,
      name: v.name,
      mimeType: v.mimeType,
      kind: v.kind as RemoteAttachment["kind"],
      size: v.size as number,
    };
  });
}

export function resolveAttachments(
  store: HostStore,
  refs: RemoteAttachment[],
): Attachment[] {
  return refs.map((ref) => {
    const path = attachmentPath(store, ref.id);
    if (statSync(path).size !== ref.size)
      throw new Error(`Attachment ${ref.name} is incomplete`);
    return { ...ref, path };
  });
}

/** Reads only an attachment already accepted into this session. Paths supplied
 * by the client are never used, and each response stays below the RPC cap. */
export function readAttachmentChunk(store: HostStore, input: Record<string, unknown>) {
  const session = store.session(String(input.sessionId ?? ""));
  const attachment = session.session.blocks.flatMap((block) => block.attachments ?? [])
    .find((file) => file.id === input.id);
  if (!attachment || attachment.kind !== "image") throw new Error("Image attachment not found");
  const offset = input.offset;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > attachment.size)
    throw new Error("Invalid attachment offset");
  const path = attachmentPath(store, attachment.id);
  if (statSync(path).size !== attachment.size) throw new Error("Attachment is incomplete");
  // Non-final chunks are divisible by three, so the client can join base64.
  const bytes = Buffer.alloc(Math.min(3 * Math.floor(MAX_CHUNK_BYTES / 3), attachment.size - Number(offset)));
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, bytes, 0, bytes.length, Number(offset));
    return { data: bytes.subarray(0, read).toString("base64"), offset: Number(offset) + read, size: attachment.size };
  } finally { closeSync(fd); }
}

/** What a phone may send inline with one message, and how much in total. The
 *  phone's own limits are 10 files and 10 MiB each; the whole body must also
 *  fit the server's 16 MiB request cap, with room for the prompt. */
const MAX_INLINE_FILES = 10;
const MAX_INLINE_BASE64 = 12 * 1024 * 1024;

/**
 * Attachments a phone sent inline, written into the store and handed back as
 * references the engine takes. A desktop uploads them chunk by chunk first
 * (`attachments.upload`) and then names them; the phone has no such step, so
 * its base64 is staged here.
 */
export function stageInlineAttachments(
  store: HostStore,
  value: unknown,
  /** The message's command id, so a retry stages the same files again rather
   *  than new ones the engine would see as a changed payload. */
  commandId: string,
): StagedAttachments {
  if (value === undefined) return { attachments: [], created: [] };
  if (!Array.isArray(value)) throw new Error("Invalid attachments");
  if (value.length > MAX_INLINE_FILES)
    throw new Error(`Send at most ${MAX_INLINE_FILES} attachments`);

  // Every one checked and decoded before any is written, so a bad one later in
  // the message cannot leave the earlier ones on disk.
  let budget = MAX_INLINE_BASE64;
  const files = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Invalid attachment");
    const { name, mimeType, data } = entry as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 255 ||
      typeof mimeType !== "string" ||
      !mimeType.trim() ||
      mimeType.length > 128 ||
      typeof data !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data) ||
      data.length % 4
    )
      throw new Error("Invalid attachment");
    budget -= data.length;
    if (budget < 0) throw new Error("These attachments are too large to send");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_REMOTE_ATTACHMENT_BYTES)
      throw new Error(`${name} is too large to send`);
    return {
      ref: {
        id: inlineAttachmentId(commandId, index),
        name,
        mimeType,
        kind: kindOf(mimeType),
        size: bytes.length,
      },
      bytes,
    };
  });

  // A file already there belongs to an earlier attempt at this same command
  // id, so its bytes must match; a message that reuses an id for something
  // else is refused without touching what the first one left. Only what this
  // attempt writes is reported as `created`, and so only that is ever removed.
  const created: RemoteAttachment[] = [];
  try {
    mkdirSync(store.attachmentDir, { recursive: true, mode: 0o700 });
    for (const { ref, bytes } of files) {
      const path = attachmentPath(store, ref.id);
      if (existsSync(path)) {
        if (!readFileSync(path).equals(bytes))
          throw new Error("Command ID was already used with different input");
        continue;
      }
      created.push(ref);
      // Written aside and moved into place, so a crash part way through leaves
      // no half file for a retry to mistake for a different message's.
      const partial = `${path}.part`;
      writeFileSync(partial, bytes, { mode: 0o600 });
      renameSync(partial, path);
    }
  } catch (error) {
    discardAttachments(store, created);
    throw error;
  }
  return { attachments: files.map((file) => file.ref), created };
}

/** The references a message's attachments got, and which this attempt wrote. */
export type StagedAttachments = {
  attachments: RemoteAttachment[];
  created: RemoteAttachment[];
};

/**
 * The id an inline attachment always gets: derived from its message's command
 * id and its place in it, shaped as a version 8 UUID. So a phone retrying a
 * send whose reply it lost — even after a host restart, which loses the record
 * of the first attempt — names the same files, and the engine sees the same
 * payload it already accepted.
 */
function inlineAttachmentId(commandId: string, index: number): string {
  const hex = createHash("sha256")
    .update(`${commandId}\u0000${index}`)
    .digest("hex");
  const version = `8${hex.slice(13, 16)}`;
  const variant = `${"89ab"[Number.parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}`;
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version,
    variant,
    hex.slice(20, 32),
  ].join("-");
}

function kindOf(mimeType: string): RemoteAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

/** Removes attachments staged for a message that never reached a session, the
 *  half-written ones of an interrupted write included. */
export function discardAttachments(
  store: HostStore,
  refs: RemoteAttachment[],
): void {
  for (const file of refs) {
    const path = attachmentPath(store, file.id);
    rmSync(path, { force: true });
    rmSync(`${path}.part`, { force: true });
  }
}
