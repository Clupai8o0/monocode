import { execFile } from "node:child_process";

export type CommandResult = {
  /** The exit code; null when it could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CommandOptions = { timeoutMs: number; env?: NodeJS.ProcessEnv };

/** Runs one command; never throws. Tests pass a fake. */
export type CommandRunner = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CommandResult>;

/**
 * The host's environment plus the user bus, which an SSH shell or a bare
 * service may lack, so systemctl --user and busctl --user reach it.
 */
export function systemdEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): NodeJS.ProcessEnv {
  const next = { ...env };
  if (uid === undefined) return next;
  if (!next.XDG_RUNTIME_DIR) next.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (!next.DBUS_SESSION_BUS_ADDRESS) {
    next.DBUS_SESSION_BUS_ADDRESS = `unix:path=${next.XDG_RUNTIME_DIR}/bus`;
  }
  return next;
}

export const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        env: options.env ?? systemdEnvironment(),
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const failure = error as
          (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        resolve({
          code: !failure
            ? 0
            : typeof failure.code === "number"
              ? failure.code
              : null,
          stdout: String(stdout ?? ""),
          stderr:
            String(stderr ?? "") ||
            (failure && typeof failure.code === "string"
              ? failure.message
              : ""),
          timedOut: Boolean(failure?.killed),
        });
      },
    );
  });

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** systemctl show's KEY=VALUE lines; blank lines split units. */
export function parseShow(text: string): Record<string, string>[] {
  const blocks: Record<string, string>[] = [];
  let current: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      if (Object.keys(current).length) blocks.push(current);
      current = {};
      continue;
    }
    const at = line.indexOf("=");
    if (at > 0) current[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  if (Object.keys(current).length) blocks.push(current);
  return blocks;
}

/** A systemd timestamp shown with --timestamp=unix ("@1793205280"); null
 *  when empty or unset. */
export function parseUnixTimestamp(value: string | undefined): number | null {
  const match = /^@(\d+)/.exec(value?.trim() ?? "");
  if (!match) return null;
  const seconds = Number(match[1]);
  return seconds > 0 ? seconds * 1000 : null;
}
