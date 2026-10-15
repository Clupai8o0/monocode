export type SortDirection = "asc" | "desc";
export type SortState = { column: number; direction: SortDirection } | null;

/** 0 → A, 25 → Z, 26 → AA, as spreadsheets name columns. */
export function columnLetter(index: number): string {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

const PLAIN_NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const GROUPED_NUMBER = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * The number a cell shows, or null. Takes `1,234.5`, `$12`, `-3e4` and `45%`
 * (as 45), so money and percentage columns sort by value.
 */
export function cellNumber(cell: string): number | null {
  let text = cell.trim();
  if (!text) {
    return null;
  }
  text = text.replace(/^([-+]?)[$€£¥]/, "$1").replace(/%$/, "");
  if (GROUPED_NUMBER.test(text)) {
    text = text.replace(/,/g, "");
  } else if (!PLAIN_NUMBER.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Numbers before text; empty cells always last, whatever the direction. */
function compareCells(a: string, b: string, direction: SortDirection): number {
  const emptyA = a.trim() === "";
  const emptyB = b.trim() === "";
  if (emptyA || emptyB) {
    return Number(emptyA) - Number(emptyB);
  }
  const sign = direction === "asc" ? 1 : -1;
  const numberA = cellNumber(a);
  const numberB = cellNumber(b);
  if (numberA !== null && numberB !== null) {
    return sign * (numberA - numberB);
  }
  if (numberA !== null || numberB !== null) {
    return sign * (numberA !== null ? -1 : 1);
  }
  return sign * collator.compare(a, b);
}

/** Row indexes in display order. The sort is stable, so ties keep file order. */
export function sortedOrder(rows: string[][], sort: SortState): number[] {
  const order = rows.map((_, index) => index);
  if (!sort) {
    return order;
  }
  return order.sort(
    (a, b) =>
      compareCells(
        rows[a][sort.column] ?? "",
        rows[b][sort.column] ?? "",
        sort.direction,
      ) || a - b,
  );
}

/** Header click cycles: ascending, descending, back to file order. */
export function nextSort(sort: SortState, column: number): SortState {
  if (sort?.column !== column) {
    return { column, direction: "asc" };
  }
  return sort.direction === "asc" ? { column, direction: "desc" } : null;
}

export function columnCount(rows: string[][]): number {
  let count = 0;
  for (const row of rows) {
    count = Math.max(count, row.length);
  }
  return count;
}
