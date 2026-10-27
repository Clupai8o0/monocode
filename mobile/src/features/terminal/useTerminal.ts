import { useCallback, useEffect, useRef, useState } from "react";

import { useConnection } from "@/features/connection/ConnectionProvider";

import {
  emptyTerminalText,
  feedTerminalText,
  type TerminalText,
} from "./terminalText";

type TerminalRead = {
  terminalId: string;
  output: string;
  cursor: number;
  dropped: boolean;
  alive: boolean;
  exitCode: number | null;
};

type Shown = {
  key: string;
  text: TerminalText;
  /** A shell was opened, so not being alive means it has stopped. */
  started: boolean;
  alive: boolean;
  exitCode: number | null;
  error: string | null;
};

const blank = (key: string): Shown => ({
  key,
  text: emptyTerminalText(),
  started: false,
  alive: false,
  exitCode: null,
  error: null,
});

/** How long one read waits on the host; under the link's 25 s timeout. */
const READ_WAIT_MS = 15_000;
/** The pause before trying again after the host could not be reached. */
const RETRY_MS = 2_000;

/**
 * The project's shell on the host. It lives on the host, not in this screen:
 * leaving and coming back picks up the same shell and its scrollback.
 */
export function useTerminal(
  projectId: string,
  worktreePath: string | undefined,
  size: { cols: number; rows: number },
) {
  const { command } = useConnection();
  const [generation, setGeneration] = useState(0);
  // Keyed to the shell it shows, so another project or a restart starts
  // from nothing without clearing state in an effect.
  const key = `${projectId}\n${worktreePath ?? ""}\n${generation}`;
  const [state, setState] = useState<Shown>(() => blank(key));
  const shown = state.key === key ? state : blank(key);
  const terminal = useRef<string | null>(null);
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  });

  useEffect(() => {
    let stopped = false;
    terminal.current = null;
    const update = (change: (current: Shown) => Partial<Shown>) =>
      setState((previous) => {
        const current = previous.key === key ? previous : blank(key);
        return { ...current, ...change(current) };
      });
    const pause = () =>
      new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    const apply = (read: TerminalRead, fresh: boolean) =>
      update((current) => ({
        text: feedTerminalText(
          fresh
            ? emptyTerminalText()
            : // A sequence cut short by the gap would swallow what follows.
              read.dropped
              ? { ...current.text, pending: "" }
              : current.text,
          read.dropped && !fresh ? `\n…\n${read.output}` : read.output,
        ),
        started: true,
        alive: read.alive,
        exitCode: read.exitCode,
        error: null,
      }));
    void (async () => {
      let cursor = 0;
      let reopen = true;
      while (!stopped) {
        try {
          if (reopen) {
            const opened = await command<TerminalRead>("terminal.open", {
              projectId,
              ...(worktreePath ? { worktreePath } : {}),
              ...sizeRef.current,
            });
            if (stopped) return;
            terminal.current = opened.terminalId;
            cursor = opened.cursor;
            reopen = false;
            apply(opened, true);
            if (!opened.alive) return;
          }
          const read = await command<TerminalRead>("terminal.read", {
            terminalId: terminal.current,
            cursor,
            timeoutMs: READ_WAIT_MS,
          });
          if (stopped) return;
          cursor = read.cursor;
          apply(read, false);
          if (!read.alive) return;
        } catch (failure) {
          if (stopped) return;
          const message =
            failure instanceof Error ? failure.message : String(failure);
          // The host restarted or closed it: open the project's shell again.
          if (/Terminal closed/.test(message)) reopen = true;
          else update(() => ({ error: message }));
          await pause();
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [command, projectId, worktreePath, key]);

  // One write at a time, in order: a Ctrl-C must not overtake the command
  // it is meant to stop.
  const writes = useRef<Promise<void>>(Promise.resolve());
  const send = useCallback(
    (data: string) => {
      const terminalId = terminal.current;
      if (!terminalId || !data) return writes.current;
      writes.current = writes.current.then(async () => {
        try {
          await command("terminal.write", { terminalId, data });
        } catch (failure) {
          const message =
            failure instanceof Error ? failure.message : String(failure);
          setState((current) => ({ ...current, error: message }));
        }
      });
      return writes.current;
    },
    [command],
  );

  /** A new shell, after the last one exited. */
  const restart = useCallback(() => setGeneration((value) => value + 1), []);

  /** Ends the shell and anything it is running. */
  const end = useCallback(async () => {
    const terminalId = terminal.current;
    if (!terminalId) return;
    await command("terminal.close", { terminalId }).catch(() => {});
  }, [command]);

  const { text, started, alive, exitCode, error } = shown;
  return { text, started, alive, exitCode, error, send, restart, end };
}
