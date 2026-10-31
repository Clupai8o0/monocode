import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "../../shared/ui/icons";
import { AskChatRegion } from "../askChat/AskChatRegion";
import {
  describeTable,
  TABLE_COLUMN_ATTR,
  TABLE_ROW_ATTR,
} from "../askChat/askChatDescribe";
import {
  cellNumber,
  columnCount,
  columnLetter,
  nextSort,
  sortedOrder,
  type SortState,
} from "./tableModel";

/** Rows drawn at first; "Show more" adds this many again. */
const PAGE_ROWS = 500;

type Props = {
  rows: string[][];
  /** Extra footer items, such as the file size or sheet tabs. */
  footer?: ReactNode;
  label: string;
  /** Where "Add to chat" says the cells came from. */
  file: string;
  sheet?: string;
};

/**
 * Fork feature: a read-only table for CSV and Excel previews. The first row
 * is the header by default; click a header to sort by it (numbers by value,
 * empty cells last).
 */
export function TableGrid({ rows, footer, label, file, sheet }: Props) {
  const [header, setHeader] = useState(true);
  const [sort, setSort] = useState<SortState>(null);
  const [limit, setLimit] = useState(PAGE_ROWS);

  const useHeader = header && rows.length > 1;
  const body = useMemo(
    () => (useHeader ? rows.slice(1) : rows),
    [rows, useHeader],
  );
  const columns = useMemo(() => columnCount(rows), [rows]);
  const order = useMemo(() => sortedOrder(body, sort), [body, sort]);
  const firstRowNumber = useHeader ? 2 : 1;
  const shown = order.slice(0, limit);
  const describe = useMemo(() => describeTable(file, sheet), [file, sheet]);

  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-content/45">
        Empty table
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
        aria-label={label}
      >
        <AskChatRegion describe={describe}>
          <table className="border-separate border-spacing-0 text-[12px] text-content">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="sticky left-0 z-10 min-w-10 border-b border-r border-stroke bg-background-base px-2 py-1 text-right font-normal text-content/35" />
                {Array.from({ length: columns }, (_, column) => {
                  const active = sort?.column === column;
                  const name = useHeader
                    ? rows[0][column] || columnLetter(column)
                    : columnLetter(column);
                  return (
                    <th
                      key={column}
                      aria-sort={
                        active
                          ? sort.direction === "asc"
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                      className="border-b border-r border-stroke bg-background-base p-0 text-left font-medium"
                      {...(useHeader
                        ? { [TABLE_COLUMN_ATTR]: column, [TABLE_ROW_ATTR]: 1 }
                        : {})}
                    >
                      <button
                        type="button"
                        title={`Sort by ${name}`}
                        onClick={() => {
                          setSort(nextSort(sort, column));
                          setLimit(PAGE_ROWS);
                        }}
                        className="flex w-full max-w-[24rem] items-center gap-1 px-2 py-1 hover:bg-content/5"
                      >
                        <span className="truncate">{name}</span>
                        {active ? (
                          sort.direction === "asc" ? (
                            <ChevronUp className="size-3 shrink-0 text-content/60" />
                          ) : (
                            <ChevronDown className="size-3 shrink-0 text-content/60" />
                          )
                        ) : null}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((index) => {
                const row = body[index];
                return (
                  <tr key={index} className="hover:bg-content/5">
                    <td className="sticky left-0 select-none border-b border-r border-stroke bg-background-base px-2 py-0.5 text-right tabular-nums text-content/35">
                      {index + firstRowNumber}
                    </td>
                    {Array.from({ length: columns }, (_, column) => {
                      const cell = row[column] ?? "";
                      return (
                        <td
                          key={column}
                          title={cell.length > 40 ? cell : undefined}
                          {...{
                            [TABLE_COLUMN_ATTR]: column,
                            [TABLE_ROW_ATTR]: index + firstRowNumber,
                          }}
                          className={`max-w-[24rem] truncate whitespace-nowrap border-b border-r border-stroke/60 px-2 py-0.5 ${
                            cellNumber(cell) !== null
                              ? "text-right tabular-nums"
                              : ""
                          }`}
                        >
                          {cell}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </AskChatRegion>
        {order.length > limit ? (
          <button
            type="button"
            onClick={() => setLimit((value) => value + PAGE_ROWS)}
            className="m-3 rounded-md bg-content/10 px-2.5 py-1 text-[12px] text-content hover:bg-content/15"
          >
            Show {Math.min(PAGE_ROWS, order.length - limit).toLocaleString()}{" "}
            more of {(order.length - limit).toLocaleString()}
          </button>
        ) : null}
      </div>
      <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-stroke px-3 text-[11px] text-content/50">
        <span className="tabular-nums">
          {body.length.toLocaleString()} rows · {columns} columns
        </span>
        <label className="flex items-center gap-1.5 hover:text-content">
          <input
            type="checkbox"
            checked={header}
            onChange={(event) => {
              setHeader(event.target.checked);
              setSort(null);
            }}
            className="size-3"
          />
          Header row
        </label>
        {footer}
      </footer>
    </div>
  );
}
