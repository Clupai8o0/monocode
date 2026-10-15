import { basename } from "../../platform/tauri/fs";

/** Same list as `fork_office.rs`. `.xlsx` has its own table view. */
const OFFICE = /\.(docx?|odt|rtf|pptx?|ppsx?|odp|xls|ods|pages)$/;

export function isOfficePath(path: string): boolean {
  return OFFICE.test(basename(path).toLowerCase());
}

export type OfficeResult = {
  status: "ok" | "no-office" | "failed";
  pdf: string | null;
  message: string | null;
  cached: boolean;
  millis: number;
};
