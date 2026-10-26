import { convertFileSrc } from "@tauri-apps/api/core";

/** HTML files open as interactive previews; reviews and line links stay code. */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Keep native's encoded segments separated so relative assets resolve normally. */
export function htmlPreviewUrl(urlPath: string): string {
  const url = convertFileSrc(urlPath, "monoartifact");
  const encoded = encodeURIComponent(urlPath);
  // Tauri encodes even `/` and existing `%` escapes because it normally serves
  // one file path. This route needs URL hierarchy. Fixture URLs can be blobs.
  return url.endsWith(encoded) ? url.slice(0, -encoded.length) + urlPath : url;
}
