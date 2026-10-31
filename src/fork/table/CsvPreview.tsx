import { useDeferredValue, useMemo } from "react";
import { basename } from "../../platform/tauri/fs";
import { displayPath } from "../../shared/lib/paths";
import { delimiterFor, parseDelimited } from "./csv";
import { TableGrid } from "./TableGrid";

const DELIMITER_NAMES: Record<string, string> = {
  ",": "Comma",
  ";": "Semicolon",
  "\t": "Tab",
};

/** Fork feature: the Preview side of a `.csv` / `.tsv` file in the editor. */
export function CsvPreview({
  path,
  source,
  cwd,
}: {
  path: string;
  source: string;
  cwd?: string;
}) {
  // Typing in the source view should not wait on re-parsing a large file.
  const text = useDeferredValue(source);
  const delimiter = useMemo(() => delimiterFor(path, text), [path, text]);
  const rows = useMemo(
    () => parseDelimited(text, delimiter),
    [text, delimiter],
  );
  return (
    <TableGrid
      rows={rows}
      label={`Table preview: ${basename(path)}`}
      file={displayPath(path, cwd)}
      footer={<span>{DELIMITER_NAMES[delimiter] ?? "Delimited"}</span>}
    />
  );
}
