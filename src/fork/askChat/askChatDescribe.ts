import {
  headingReference,
  lineReference,
  notebookReference,
  cellReference,
  pageReference,
} from "./askChatModel";

export type AskChatDescription = {
  reference: string;
  /** Replaces the selected text, when the view can give a truer copy of it. */
  text?: string;
  /** The cells that text comes from, when they differ from what is highlighted. */
  cells?: Element[];
};

export type AskChatDescribe = (
  range: Range,
  root: HTMLElement,
) => AskChatDescription | null;

export const PDF_PAGE_ATTR = "data-ask-page";
export const NOTEBOOK_CELL_ATTR = "data-ask-cell";
export const TABLE_COLUMN_ATTR = "data-ask-column";
export const TABLE_ROW_ATTR = "data-ask-row";
export const DIFF_LINE_ATTR = "data-ask-line";
export const DIFF_PATH_ATTR = "data-ask-path";
export const DIFF_REMOVED_ATTR = "data-ask-removed";

function selectsTextIn(range: Range, element: Element): boolean {
  if (!range.intersectsNode(element)) return false;
  const part = document.createRange();
  part.selectNodeContents(element);
  if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
    part.setStart(range.startContainer, range.startOffset);
  }
  if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
    part.setEnd(range.endContainer, range.endOffset);
  }
  return part.toString().trim().length > 0;
}

/**
 * The marked elements the selection really takes text from. A range can touch
 * the next element without selecting anything in it, as a triple-click does.
 */
function selectedMarks(
  range: Range,
  root: HTMLElement,
  attribute: string,
): Element[] {
  return Array.from(root.querySelectorAll(`[${attribute}]`)).filter((element) =>
    selectsTextIn(range, element),
  );
}

function ends(marks: Element[], attribute: string): [number, number] | null {
  if (marks.length === 0) return null;
  const first = Number(marks[0].getAttribute(attribute));
  const last = Number(marks[marks.length - 1].getAttribute(attribute));
  return Number.isFinite(first) && Number.isFinite(last) ? [first, last] : null;
}

export function describePdf(file: string): AskChatDescribe {
  return (range, root) => {
    const pages = ends(
      selectedMarks(range, root, PDF_PAGE_ATTR),
      PDF_PAGE_ATTR,
    );
    return pages ? { reference: pageReference(file, ...pages) } : null;
  };
}

export function describeNotebook(file: string): AskChatDescribe {
  return (range, root) => {
    const cells = ends(
      selectedMarks(range, root, NOTEBOOK_CELL_ATTR),
      NOTEBOOK_CELL_ATTR,
    );
    return cells ? { reference: notebookReference(file, ...cells) } : null;
  };
}

/** The last heading that starts before the selection does. */
export function describeHeading(file: string): AskChatDescribe {
  return (range, root) => {
    let heading: string | null = null;
    for (const element of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      if (range.comparePoint(element, 0) >= 0) break;
      heading = element.textContent;
    }
    return { reference: headingReference(file, heading) };
  };
}

export function describeDiff(): AskChatDescribe {
  return (range, root) => {
    const lines = selectedMarks(range, root, DIFF_LINE_ATTR);
    const numbers = ends(lines, DIFF_LINE_ATTR);
    if (!numbers) return null;
    const startPath = lines[0].getAttribute(DIFF_PATH_ATTR) ?? "";
    const endPath = lines[lines.length - 1].getAttribute(DIFF_PATH_ATTR) ?? "";
    if (startPath !== endPath) {
      return {
        reference: `${lineReference(startPath, numbers[0], numbers[0], lines[0].hasAttribute(DIFF_REMOVED_ATTR))} to ${lineReference(endPath, numbers[1], numbers[1], lines[lines.length - 1].hasAttribute(DIFF_REMOVED_ATTR))}`,
      };
    }
    // Removed lines count from the old file and the rest from the new one, so
    // a single span across both would name lines that were never selected.
    const removed = lines.filter((line) =>
      line.hasAttribute(DIFF_REMOVED_ATTR),
    );
    const current = lines.filter(
      (line) => !line.hasAttribute(DIFF_REMOVED_ATTR),
    );
    const removedSpan = ends(removed, DIFF_LINE_ATTR);
    const currentSpan = ends(current, DIFF_LINE_ATTR);
    if (removedSpan && currentSpan) {
      const [first, last] = removedSpan;
      const old = first === last ? `${first}` : `${first}-${last}`;
      return {
        reference: `${lineReference(startPath, ...currentSpan)} and removed lines ${old}`,
      };
    }
    return {
      reference: lineReference(startPath, ...numbers, removed.length > 0),
    };
  };
}

/**
 * The cell a selection starts or ends in, which counts even when empty: its
 * column is part of the rectangle though it has no text. A cell with text the
 * range only touches does not count, as when a selection ends at the very
 * start of the next one.
 */
function cornerCell(container: Node, range: Range): Element | null {
  const element =
    container instanceof Element ? container : container.parentElement;
  const cell = element?.closest(`[${TABLE_COLUMN_ATTR}]`) ?? null;
  if (!cell) return null;
  return !cell.textContent?.trim() || selectsTextIn(range, cell) ? cell : null;
}

/**
 * A drag across a table selects in document order, right to the end of the
 * first row and from the start of the last. Spreadsheets mean the rectangle
 * between the two corners, so that is what gets named and sent; within one
 * cell the selected words go as they are.
 */
export function describeTable(file: string, sheet?: string): AskChatDescribe {
  return (range, root) => {
    const cells = selectedMarks(range, root, TABLE_COLUMN_ATTR);
    if (cells.length === 0) return null;
    const first = cornerCell(range.startContainer, range) ?? cells[0];
    const last =
      cornerCell(range.endContainer, range) ?? cells[cells.length - 1];
    const startColumn = Number(first.getAttribute(TABLE_COLUMN_ATTR));
    const endColumn = Number(last.getAttribute(TABLE_COLUMN_ATTR));
    const firstRow = first.closest("tr");
    const lastRow = last.closest("tr");
    const table = first.closest("table");
    if (!firstRow || !lastRow || !table) return null;
    if (first === last) {
      return {
        reference: cellReference({
          file,
          sheet,
          firstColumn: startColumn,
          lastColumn: endColumn,
          rows: [Number(first.getAttribute(TABLE_ROW_ATTR))],
        }),
      };
    }
    const left = Math.min(startColumn, endColumn);
    const right = Math.max(startColumn, endColumn);
    const all = Array.from(table.rows);
    const shown = all.slice(all.indexOf(firstRow), all.indexOf(lastRow) + 1);
    const rows: number[] = [];
    const lines: string[] = [];
    const chosen: Element[] = [];
    for (const row of shown) {
      const values: string[] = [];
      let number: number | null = null;
      for (const cell of row.querySelectorAll(`[${TABLE_COLUMN_ATTR}]`)) {
        const column = Number(cell.getAttribute(TABLE_COLUMN_ATTR));
        if (column < left || column > right) continue;
        number = Number(cell.getAttribute(TABLE_ROW_ATTR));
        values.push(cell.textContent ?? "");
        chosen.push(cell);
      }
      if (number !== null) {
        rows.push(number);
        lines.push(values.join("\t"));
      }
    }
    return {
      reference: cellReference({
        file,
        sheet,
        firstColumn: left,
        lastColumn: right,
        rows,
      }),
      text: lines.join("\n"),
      cells: chosen,
    };
  };
}
