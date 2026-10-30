/**
 * Fork: run Claude Code's ultrareview (a billed, cloud-hosted multi-agent
 * review) from the composer. The button asks App to open a project terminal
 * and queues `claude ultrareview [target]` for it; the terminal types the
 * command once its shell has started, so the CLI's own prompts still reach
 * the user.
 */

export const ULTRAREVIEW_EVENT = "monocode:fork-ultrareview";

/** A queued command is dropped if no terminal claims it this soon. */
const START_INPUT_TTL_MS = 10_000;

type StartInput = { cwd: string; text: string; at: number };

// First in, first out: two quick requests open two terminals, in that order.
let pending: StartInput[] = [];

/** PR number or base branch; it is typed into a shell, so plain ref characters only. */
const TARGET = /^(?:#?\d+|[A-Za-z0-9][A-Za-z0-9._/-]*)$/;

/** Shell line for a target ("" = the current branch), or null if the target is unsafe. */
export function ultrareviewCommand(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) return "claude ultrareview\r";
  if (!TARGET.test(trimmed) || trimmed.includes("..")) return null;
  return `claude ultrareview ${trimmed.replace(/^#/, "")}\r`;
}

/** Asks App to open a terminal in the current project and run the review there. */
export function requestUltrareview(target: string): boolean {
  const command = ultrareviewCommand(target);
  if (!command) return false;
  window.dispatchEvent(
    new CustomEvent<string>(ULTRAREVIEW_EVENT, { detail: command }),
  );
  return true;
}

/** App: remember the command for the terminal about to open in `cwd`. */
export function queueTerminalStartInput(
  cwd: string,
  text: string,
  now = Date.now(),
): void {
  pending.push({ cwd, text, at: now });
}

/** TerminalView: the oldest queued command for a terminal that just started in `cwd`, once. */
export function takeTerminalStartInput(
  cwd: string,
  now = Date.now(),
): string | undefined {
  pending = pending.filter((input) => now - input.at <= START_INPUT_TTL_MS);
  const index = pending.findIndex((input) => input.cwd === cwd);
  if (index < 0) return undefined;
  const [input] = pending.splice(index, 1);
  return input.text;
}
