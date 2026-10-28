import type { CommandResult, CommandRunner } from "./lab-system";

export type FakeAnswer =
  Partial<CommandResult> | ((args: string[]) => Partial<CommandResult>);

/**
 * Tests only: a command runner that answers from a table keyed by "command arg arg"
 * prefixes (longest match wins) and records every call.
 */
export function fakeRunner(table: Record<string, FakeAnswer>) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args, options) => {
    if (!(options.timeoutMs > 0)) throw new Error("no timeout");
    const line = [command, ...args].join(" ");
    calls.push(line);
    const key = Object.keys(table)
      .filter((prefix) => line === prefix || line.startsWith(`${prefix} `))
      .sort((a, b) => b.length - a.length)[0];
    const answer = key === undefined ? { code: 1 } : table[key]!;
    const result = typeof answer === "function" ? answer(args) : answer;
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { run, calls };
}
