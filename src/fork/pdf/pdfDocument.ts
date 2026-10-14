import type * as PdfJs from "pdfjs-dist";
import { basename } from "../../platform/tauri/fs";

/** Route `.pdf` files to the PDF viewer instead of the text editor. */
export function isPdfPath(path: string): boolean {
  return basename(path).toLowerCase().endsWith(".pdf");
}

let loading: Promise<typeof PdfJs> | null = null;

/**
 * Load pdf.js on first use, so the app does not pay for it at startup.
 *
 * The worker is a same-origin module file, which the app CSP already allows
 * (`script-src 'self'`). Nothing else is fetched: see `openPdf`.
 */
export function loadPdfJs(): Promise<typeof PdfJs> {
  loading ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
    (cause: unknown) => {
      loading = null;
      throw cause;
    },
  );
  return loading;
}

/**
 * Open PDF bytes for canvas rendering.
 *
 * The CSP allows neither `connect-src 'self'` nor wasm, so pdf.js is told not
 * to fetch its wasm decoders or font data. Fonts a PDF does not embed fall
 * back to system fonts.
 */
export async function openPdf(
  bytes: Uint8Array,
): Promise<PdfJs.PDFDocumentLoadingTask> {
  const pdfjs = await loadPdfJs();
  return pdfjs.getDocument({
    data: bytes,
    useWasm: false,
    enableXfa: false,
    useSystemFonts: true,
  });
}
