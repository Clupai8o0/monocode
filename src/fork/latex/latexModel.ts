import { basename } from "../../platform/tauri/fs";

/** Route `.tex` files to the side-by-side LaTeX layout. */
export function isTexPath(path: string): boolean {
  return basename(path).toLowerCase().endsWith(".tex");
}

export type LatexIssue = {
  file: string | null;
  line: number | null;
  message: string;
};

export type LatexResult = {
  status: "ok" | "errors" | "no-tex" | "not-root";
  pdf: string | null;
  root: string;
  engine: string;
  errors: LatexIssue[];
  warnings: number;
  notes: string[];
  logTail: string;
  millis: number;
};

export type LatexLayout = "split" | "source" | "pdf";

/** Clamp the source pane's share of the width to something usable. */
export function clampSplit(ratio: number): number {
  return Math.min(0.8, Math.max(0.2, Number.isFinite(ratio) ? ratio : 0.5));
}

/** `ch/one.tex:12` relative to the root's folder when it is inside it. */
export function issueLabel(issue: LatexIssue, root: string): string {
  if (!issue.file) {
    return "";
  }
  const folder = root.slice(0, root.lastIndexOf("/") + 1);
  const file = issue.file.startsWith(folder)
    ? issue.file.slice(folder.length)
    : basename(issue.file);
  return issue.line ? `${file}:${issue.line}` : file;
}

export function formatMillis(millis: number): string {
  return millis < 1000 ? `${millis} ms` : `${(millis / 1000).toFixed(1)} s`;
}
