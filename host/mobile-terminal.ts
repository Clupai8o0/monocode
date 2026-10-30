import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * A shell per project for the phone, kept on the host so it outlives the
 * screen: leave it, come back, and the scrollback and anything still running
 * are where they were. The phone reads with a cursor into the output and
 * long-polls for more, as it does for watches.
 *
 * There is no node-pty in the bundle (it is native), so `script` or Python
 * gives the shell a real terminal. The shell is bash with TERM=xterm-256color:
 * the phone renders colours and readline's line editing, though not a full
 * screen, so pagers are `cat` (see `terminalEnv`).
 */

/** Output kept per terminal; older output is dropped from the front. */
export const MAX_OUTPUT_LINES = 5_000;
export const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
/** Sent in one reply, so a long replay can't stall the phone or the link. */
export const MAX_READ_CHARS = 512 * 1024;
/** The longest a read waits for output before answering with none. */
const READ_MAX_MS = 15_000;
/** Input accepted in one write. */
const MAX_WRITE_CHARS = 64 * 1024;
/** Shells left unread this long are closed. */
const IDLE_MS = 6 * 60 * 60_000;
/** Shells open at once across every project. */
const MAX_TERMINALS = 8;
/** How long a closed shell gets to exit before it is killed outright. */
const KILL_GRACE_MS = 2_000;

type Terminal = {
  id: string;
  cwd: string;
  child: ChildProcess;
  output: string;
  /** Characters dropped from the front of `output` so far. */
  start: number;
  /** Newlines in `output`, so trimming needn't count them on every chunk. */
  lines: number;
  alive: boolean;
  exitCode: number | null;
  used: number;
  waiters: Set<() => void>;
};

export type TerminalRead = {
  terminalId: string;
  output: string;
  /** Where the next read starts. */
  cursor: number;
  /** Output between the asked cursor and this reply was dropped. */
  dropped: boolean;
  /** More output is ready now: a long replay, arriving in pieces. */
  more: boolean;
  alive: boolean;
  exitCode: number | null;
};

const countLines = (text: string) => {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    count++;
  return count;
};

/** How many characters to drop from the front to stay within both limits. */
export function outputOverflow(
  output: string,
  lines: number,
  maxLines = MAX_OUTPUT_LINES,
  maxChars = MAX_OUTPUT_CHARS,
): number {
  let drop = Math.max(0, output.length - maxChars);
  let left = lines - (drop ? countLines(output.slice(0, drop)) : 0);
  while (left > maxLines) {
    const next = output.indexOf("\n", drop);
    if (next === -1) break;
    drop = next + 1;
    left--;
  }
  return drop;
}

/** Gives a command a terminal of its own, for systems without `script`. */
const PYTHON_PTY =
  "import os,pty,sys; s=pty.spawn(sys.argv[1:]); sys.exit(os.waitstatus_to_exitcode(s))";

const onPath = (name: string) =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, name)));

/**
 * The command that runs an interactive shell under a terminal of this size:
 * `script` where it is installed, else Python's `pty` (Fedora leaves `script`
 * out of its base install; macOS ships both).
 */
export function terminalCommand(
  platform: NodeJS.Platform,
  cols: number,
  rows: number,
  has: (name: string) => boolean = onPath,
): { command: string; args: string[] } {
  if (platform !== "linux" && platform !== "darwin")
    throw new Error("The terminal is not available on this host's system yet");
  const shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  const inner = `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${shell} -i`;
  if (has("script"))
    return platform === "linux"
      ? { command: "script", args: ["-qfec", inner, "/dev/null"] }
      : { command: "script", args: ["-q", "/dev/null", "/bin/sh", "-c", inner] };
  if (has("python3"))
    return {
      command: "python3",
      args: ["-c", PYTHON_PTY, "/bin/sh", "-c", inner],
    };
  throw new Error("The terminal needs `script` or `python3` on this host");
}

/**
 * The shell's environment: a colour terminal, so `ls`, git and test runners
 * print colours the phone renders, with every pager turned into `cat` and
 * no editor that takes the whole screen, since the phone has no screen.
 */
export function terminalEnv(
  base: NodeJS.ProcessEnv,
  zone: string | null = null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PAGER: "cat",
    GIT_PAGER: "cat",
    MANPAGER: "cat",
    SYSTEMD_PAGER: "cat",
    LESS: "-FRX",
    EDITOR: "ed",
    VISUAL: "ed",
    GIT_EDITOR: "ed",
    GIT_SEQUENCE_EDITOR: "ed",
  };
  delete env.NO_COLOR;
  // Fork: the agent time zone picked in the home lab settings.
  if (zone) env.TZ = zone;
  return env;
}

const size = (value: unknown, fallback: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(20, Math.floor(value)))
    : fallback;

/** Every process below `root`, read once from `ps`. */
export function descendants(root: number): number[] {
  let listing: string;
  try {
    listing = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (found.includes(child)) continue;
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

export function createMobileTerminals(
  platform = process.platform,
  timeZone: () => string | null = () => null,
) {
  const terminals = new Map<string, Terminal>();
  /** Shells hung up and waiting out their grace before the kill. */
  const closing = new Set<() => void>();

  const wake = (terminal: Terminal) => {
    for (const waiter of terminal.waiters) waiter();
    terminal.waiters.clear();
  };
  /** Hangs the shell up, then kills what is left; at once when `now`. */
  const kill = (terminal: Terminal, now = false) => {
    terminals.delete(terminal.id);
    wake(terminal);
    if (!terminal.alive || terminal.child.pid === undefined) return;
    // The wrapper's group, and every process under it: the shell runs in a
    // terminal session of its own, so its commands are in other groups, and
    // one that ignores the hangup must still go when the grace runs out.
    const pids = [terminal.child.pid, ...descendants(terminal.child.pid)];
    const signal = (name: NodeJS.Signals) => {
      for (const target of [-terminal.child.pid!, ...pids])
        try {
          process.kill(target, name);
        } catch {
          // Already gone.
        }
    };
    if (now) return signal("SIGKILL");
    signal("SIGHUP");
    // Remembered through the grace, so a host exiting meanwhile still kills it.
    const finish = () => {
      closing.delete(finish);
      signal("SIGKILL");
    };
    closing.add(finish);
    setTimeout(finish, KILL_GRACE_MS).unref();
  };
  const sweep = () => {
    const now = Date.now();
    for (const terminal of terminals.values())
      if (now - terminal.used > IDLE_MS) kill(terminal);
  };
  setInterval(sweep, 60_000).unref();
  // A host that stops takes its shells with it. No timer runs after exit, so
  // there is no grace: what is left is killed outright.
  process.once("exit", () => {
    for (const terminal of [...terminals.values()]) kill(terminal, true);
    for (const finish of [...closing]) finish();
  });

  const find = (terminalId: unknown) => {
    const terminal = terminals.get(String(terminalId ?? ""));
    if (!terminal) throw new Error("Terminal closed");
    terminal.used = Date.now();
    return terminal;
  };

  const slice = (terminal: Terminal, cursor: unknown): TerminalRead => {
    const end = terminal.start + terminal.output.length;
    const asked =
      typeof cursor === "number" && Number.isFinite(cursor) ? cursor : 0;
    const from = Math.min(Math.max(asked, terminal.start), end);
    let to = Math.min(end, from + MAX_READ_CHARS);
    // Never split a surrogate pair across two replies.
    const last = terminal.output.charCodeAt(to - terminal.start - 1);
    if (to < end && last >= 0xd800 && last <= 0xdbff) to--;
    return {
      terminalId: terminal.id,
      output: terminal.output.slice(from - terminal.start, to - terminal.start),
      cursor: to,
      dropped: asked < terminal.start,
      more: to < end,
      alive: terminal.alive,
      exitCode: terminal.exitCode,
    };
  };

  /** The folder's shell, started if it has none or its last one exited. */
  const open = (cwd: string, params: Record<string, unknown>) => {
    sweep();
    for (const terminal of terminals.values())
      if (terminal.cwd === cwd) {
        if (terminal.alive) {
          terminal.used = Date.now();
          return slice(terminal, 0);
        }
        terminals.delete(terminal.id);
      }
    // Exited shells give their place up first, the longest unread going first.
    for (const terminal of [...terminals.values()]
      .filter((entry) => !entry.alive)
      .sort((a, b) => a.used - b.used)) {
      if (terminals.size < MAX_TERMINALS) break;
      kill(terminal);
    }
    if (terminals.size >= MAX_TERMINALS)
      throw new Error("Too many terminals are open on this host");
    const { command, args } = terminalCommand(
      platform,
      size(params.cols, 80, 500),
      size(params.rows, 40, 200),
    );
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: terminalEnv(process.env, timeZone()),
    });
    const terminal: Terminal = {
      // Unique across restarts, so a phone still holding an old id never
      // reaches a shell another project has since opened.
      id: randomUUID(),
      cwd,
      child,
      output: "",
      start: 0,
      lines: 0,
      alive: true,
      exitCode: null,
      used: Date.now(),
      waiters: new Set(),
    };
    const decoder = new StringDecoder("utf8");
    const append = (chunk: Buffer) => {
      const text = decoder.write(chunk);
      terminal.output += text;
      terminal.lines += countLines(text);
      const over = outputOverflow(terminal.output, terminal.lines);
      if (over > 0) {
        terminal.lines -= countLines(terminal.output.slice(0, over));
        terminal.output = terminal.output.slice(over);
        terminal.start += over;
      }
      wake(terminal);
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    child.stdin!.on("error", () => {});
    const exited = (code: number | null) => {
      if (!terminal.alive) return;
      terminal.alive = false;
      terminal.exitCode = code;
      wake(terminal);
    };
    child.on("error", (error) => {
      terminal.output += `\n${error.message}\n`;
      exited(null);
    });
    child.on("exit", exited);
    terminals.set(terminal.id, terminal);
    return slice(terminal, 0);
  };

  const read = async (params: Record<string, unknown>) => {
    const terminal = find(params.terminalId);
    const current = slice(terminal, params.cursor);
    if (current.output || current.dropped || !terminal.alive) return current;
    const wait = Math.min(
      Math.max(0, Number(params.timeoutMs) || 0),
      READ_MAX_MS,
    );
    if (wait > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait);
        function done() {
          clearTimeout(timer);
          terminal.waiters.delete(done);
          resolve();
        }
        terminal.waiters.add(done);
      });
    if (!terminals.has(terminal.id)) throw new Error("Terminal closed");
    return slice(terminal, params.cursor);
  };

  const write = (params: Record<string, unknown>) => {
    const terminal = find(params.terminalId);
    if (typeof params.data !== "string" || !params.data)
      throw new Error("Nothing to send");
    if (params.data.length > MAX_WRITE_CHARS)
      throw new Error("That is too much to send at once");
    if (!terminal.alive) throw new Error("The shell has exited");
    terminal.child.stdin!.write(params.data);
    return {};
  };

  const close = (params: Record<string, unknown>) => {
    const terminal = terminals.get(String(params.terminalId ?? ""));
    if (terminal) kill(terminal);
    return {};
  };

  return { open, read, write, close };
}
