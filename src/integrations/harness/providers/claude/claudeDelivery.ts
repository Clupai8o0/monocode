/** Claude's SendUserFile receipt belongs to its own UI; expose local files here. */
export function claudeFileDelivery(
  name: string,
  input: Record<string, unknown>,
  cwd?: string,
  result?: unknown,
  receipt = "",
): string | undefined {
  if (name !== "SendUserFile") {
    return undefined;
  }
  const record = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
  const attachments = Array.isArray(record?.attachments) ? record.attachments : undefined;
  if (!attachments && /could NOT be delivered/i.test(receipt)) return undefined;
  const files = attachments
    ? attachments.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const file = entry as Record<string, unknown>;
        return file.upload_error ? [] : [file.path];
      })
    : typeof input.files === "string" ? [input.files] : Array.isArray(input.files) ? input.files : [];
  const links = files.flatMap((file: unknown) => {
    if (
      typeof file !== "string" || /[\r\n\0]/.test(file) ||
      (!file.startsWith("/") && !/^[a-z]:[\\/]/i.test(file) && (!cwd || /^[a-z][a-z\d+.-]*:/i.test(file)))
    ) {
      return [];
    }
    const path = file.startsWith("~/")
      ? file
      : /^[a-z]:[\\/]/i.test(file) ? file.replace(/\\/g, "/")
      : file.startsWith("/") ? file : `${cwd?.replace(/\/$/, "")}/${file}`;
    if (!path) return [];
    const label = path
      .split("/")
      .pop()
      ?.replace(/[\\[\]<>`*_]/g, "\\$&");
    if (!label) {
      return [];
    }
    const target = path.split("/").map(encodeURIComponent).join("/");
    return [`[${label}](<${target}>)`];
  });
  if (!links.length) {
    return undefined;
  }
  const caption = typeof input.caption === "string" ? input.caption.trim() : "";
  return [caption, links.join("\n\n")].filter(Boolean).join("\n\n");
}
