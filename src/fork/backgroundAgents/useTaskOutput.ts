import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { stripAnsi } from "../notebook/notebookModel";

const POLL_MS = 1000;

/** What fork_task_output_tail hands back; null while the file does not exist. */
type TaskOutputTail = { text: string; truncated: boolean; size: number };

export type TaskOutput = {
  /** Undefined until the first read comes back. */
  text?: string;
  /** Earlier output exists and was left out. */
  truncated: boolean;
  /** The file can't be read here: refused, or on another machine. */
  unavailable: boolean;
};

const NOTHING: TaskOutput = { truncated: false, unavailable: false };

/** What a terminal would show: no colour codes, and only a line's last redraw. */
export function cleanOutput(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .map((line) => {
      const end = line.replace(/\r+$/, "");
      return end.slice(end.lastIndexOf("\r") + 1);
    })
    .join("\n")
    .trimEnd();
}

/**
 * The output so far of a command still running. Reads only while its row is
 * open and the window is showing; a read waits for the one before it.
 */
export function useTaskOutput(
  path: string | undefined,
  open: boolean,
): TaskOutput {
  const [output, setOutput] = useState(NOTHING);
  useEffect(() => {
    if (!open || !path) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seen: string | undefined;
    const next = () => {
      timer = setTimeout(read, POLL_MS);
    };
    const read = () => {
      if (document.hidden) {
        next();
        return;
      }
      invoke<TaskOutputTail | null>("fork_task_output_tail", { path }).then(
        (tail) => {
          if (cancelled) {
            return;
          }
          const raw = tail?.text ?? "";
          if (raw !== seen) {
            seen = raw;
            setOutput({
              text: cleanOutput(raw),
              truncated: !!tail?.truncated,
              unavailable: false,
            });
          }
          next();
        },
        () => {
          if (!cancelled) {
            setOutput({ truncated: false, unavailable: true });
          }
        },
      );
    };
    read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, open]);
  return output;
}
