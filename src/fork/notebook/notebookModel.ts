import { basename } from "../../platform/tauri/fs";

/** Route Jupyter notebooks to the cell preview. */
export function isNotebookPath(path: string): boolean {
  return basename(path).toLowerCase().endsWith(".ipynb");
}

export type NotebookOutput =
  | { kind: "text"; text: string; stream?: "stdout" | "stderr" }
  | { kind: "image"; mime: string; src: string }
  | { kind: "svg"; source: string }
  | { kind: "markdown"; text: string }
  | { kind: "error"; name: string; text: string }
  | { kind: "hidden"; mimes: string[] };

export type NotebookCell = {
  kind: "markdown" | "code" | "raw";
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
};

export type Notebook = { language: string; cells: NotebookCell[] };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** nbformat stores text as a string or a list of lines. */
function joinText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value)
    ? value.filter((part) => typeof part === "string").join("")
    : "";
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Images the webview can show from a data URL. */
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * The richest output we can show safely. HTML (pandas tables, widgets) and
 * JavaScript never render: they could run script in the app. Their
 * `text/plain` twin is shown instead when the notebook has one.
 */
function richOutput(data: Json): NotebookOutput {
  for (const mime of IMAGE_MIMES) {
    const base64 = joinText(data[mime]).replace(/\s+/g, "");
    if (base64) {
      return { kind: "image", mime, src: `data:${mime};base64,${base64}` };
    }
  }
  const svg = joinText(data["image/svg+xml"]);
  if (svg) {
    return { kind: "svg", source: svg };
  }
  const markdown = joinText(data["text/markdown"]);
  if (markdown) {
    return { kind: "markdown", text: markdown };
  }
  const plain = joinText(data["text/plain"]);
  if (plain) {
    return { kind: "text", text: stripAnsi(plain) };
  }
  return { kind: "hidden", mimes: Object.keys(data) };
}

function parseOutput(output: unknown): NotebookOutput | null {
  if (!isObject(output)) {
    return null;
  }
  switch (output.output_type) {
    case "stream":
      return {
        kind: "text",
        text: stripAnsi(joinText(output.text)),
        stream: output.name === "stderr" ? "stderr" : "stdout",
      };
    case "execute_result":
    case "display_data":
      return isObject(output.data) ? richOutput(output.data) : null;
    case "error": {
      const traceback = Array.isArray(output.traceback)
        ? output.traceback.filter((line) => typeof line === "string").join("\n")
        : "";
      const name = typeof output.ename === "string" ? output.ename : "Error";
      const value = typeof output.evalue === "string" ? output.evalue : "";
      return {
        kind: "error",
        name,
        text: stripAnsi(traceback || `${name}: ${value}`),
      };
    }
    default:
      return null;
  }
}

/** Markdown cells point at pasted images as `attachment:name.png`. */
function inlineAttachments(source: string, attachments: unknown): string {
  if (!isObject(attachments)) {
    return source;
  }
  return source.replace(/\(attachment:([^)\s]+)\)/g, (whole, name: string) => {
    const bundle = attachments[decodeURIComponent(name)];
    if (!isObject(bundle)) {
      return whole;
    }
    for (const mime of IMAGE_MIMES) {
      const base64 = joinText(bundle[mime]).replace(/\s+/g, "");
      if (base64) {
        return `(data:${mime};base64,${base64})`;
      }
    }
    return whole;
  });
}

/** Parse an nbformat 4 notebook. Throws a readable error for anything else. */
export function parseNotebook(text: string): Notebook {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The notebook is not valid JSON.");
  }
  if (!isObject(json)) {
    throw new Error("The notebook is not valid JSON.");
  }
  if (typeof json.nbformat === "number" && json.nbformat < 4) {
    throw new Error(
      `Notebook format ${json.nbformat} is too old to preview; open it in Jupyter to upgrade it.`,
    );
  }
  if (!Array.isArray(json.cells)) {
    throw new Error("The notebook has no cells list.");
  }
  const metadata = isObject(json.metadata) ? json.metadata : {};
  const languageInfo = isObject(metadata.language_info)
    ? metadata.language_info
    : {};
  const kernel = isObject(metadata.kernelspec) ? metadata.kernelspec : {};
  const language =
    (typeof languageInfo.name === "string" && languageInfo.name) ||
    (typeof kernel.language === "string" && kernel.language) ||
    "python";

  const cells = json.cells.filter(isObject).map((cell): NotebookCell => {
    const kind =
      cell.cell_type === "markdown" || cell.cell_type === "raw"
        ? cell.cell_type
        : "code";
    const source = joinText(cell.source);
    return {
      kind,
      source:
        kind === "markdown"
          ? inlineAttachments(source, cell.attachments)
          : source,
      executionCount:
        typeof cell.execution_count === "number" ? cell.execution_count : null,
      outputs: Array.isArray(cell.outputs)
        ? cell.outputs
            .map(parseOutput)
            .filter((output): output is NotebookOutput => output !== null)
        : [],
    };
  });
  return { language: language.toLowerCase(), cells };
}

/** A fence longer than any backtick run inside, so code cannot close it. */
export function fenced(code: string, language: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}
