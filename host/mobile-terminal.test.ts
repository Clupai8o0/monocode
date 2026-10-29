import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createMobileTerminals,
  terminalCommand,
  terminalEnv,
} from "./mobile-terminal";

it("gives the shell a colour terminal with no pager or full-screen editor", () => {
  const env = terminalEnv({ PATH: "/bin", NO_COLOR: "1", TERM: "dumb" });
  expect(env).toMatchObject({
    PATH: "/bin",
    TERM: "xterm-256color",
    PAGER: "cat",
    GIT_PAGER: "cat",
    EDITOR: "ed",
  });
  expect(env.NO_COLOR).toBeUndefined();
});

it("sets TZ only when an agent time zone is stored", () => {
  expect(terminalEnv({ PATH: "/bin" }).TZ).toBeUndefined();
  expect(terminalEnv({ PATH: "/bin" }, "Asia/Kolkata").TZ).toBe("Asia/Kolkata");
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function until(
  terminals: ReturnType<typeof createMobileTerminals>,
  terminalId: string,
  match: (output: string) => boolean,
) {
  let output = "";
  let cursor = 0;
  for (let i = 0; i < 40; i++) {
    const read = await terminals.read({ terminalId, cursor, timeoutMs: 500 });
    output += read.output;
    cursor = read.cursor;
    if (match(output)) return { output, cursor, read };
  }
  throw new Error(`Timed out; got: ${output}`);
}

it.runIf(process.platform === "linux")(
  "runs commands in the project's folder and keeps the shell for the next open",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "monocode-terminal-test-"));
    directories.push(cwd);
    const terminals = createMobileTerminals();
    const opened = terminals.open(cwd, { cols: 60, rows: 20 });
    terminals.write({ terminalId: opened.terminalId, data: "pwd; stty size\r" });
    const first = await until(terminals, opened.terminalId, (output) =>
      output.includes(cwd) && /\b60\b/.test(output),
    );
    expect(first.read.alive).toBe(true);

    const again = terminals.open(cwd, {});
    expect(again.terminalId).toBe(opened.terminalId);
    expect(again.output).toContain(cwd);

    terminals.write({ terminalId: opened.terminalId, data: "exit 3\r" });
    const exited = await until(terminals, opened.terminalId, () => false).catch(
      () => null,
    );
    expect(exited).toBeNull();
    const last = await terminals.read({
      terminalId: opened.terminalId,
      cursor: first.cursor,
      timeoutMs: 0,
    });
    expect(last.alive).toBe(false);
    expect(() =>
      terminals.write({ terminalId: opened.terminalId, data: "ls\r" }),
    ).toThrow(/exited/);

    const fresh = terminals.open(cwd, {});
    expect(fresh.terminalId).not.toBe(opened.terminalId);
    terminals.close({ terminalId: fresh.terminalId });
    await expect(
      terminals.read({ terminalId: fresh.terminalId, cursor: 0 }),
    ).rejects.toThrow(/closed/);
  },
  30_000,
);

it("answers a read with no new output after its wait", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "monocode-terminal-test-"));
  directories.push(cwd);
  const terminals = createMobileTerminals();
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const opened = terminals.open(cwd, {});
  const settled = await until(terminals, opened.terminalId, (output) =>
    output.length > 0,
  );
  const started = Date.now();
  const idle = await terminals.read({
    terminalId: opened.terminalId,
    cursor: settled.cursor + 10_000,
    timeoutMs: 300,
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(idle.output).toBe("");
  terminals.close({ terminalId: opened.terminalId });
});

it("refuses systems it has no terminal for", () => {
  expect(() => terminalCommand("win32", 80, 40)).toThrow(/not available/);
  expect(terminalCommand("linux", 80, 40, () => true).command).toBe("script");
  expect(
    terminalCommand("linux", 80, 40, (name) => name === "python3").command,
  ).toBe("python3");
  expect(() => terminalCommand("darwin", 80, 40, () => false)).toThrow(
    /needs/,
  );
});

it.runIf(process.platform === "linux")(
  "ends a command that ignores the hangup when its shell is closed",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "monocode-terminal-test-"));
    directories.push(cwd);
    const terminals = createMobileTerminals();
    const opened = terminals.open(cwd, {});
    terminals.write({
      terminalId: opened.terminalId,
      data: `bash -c 'trap "" HUP; echo "PID=$$="; exec sleep 60'\r`,
    });
    const { output } = await until(terminals, opened.terminalId, (text) =>
      /PID=\d+=/.test(text),
    );
    const pid = Number(/PID=(\d+)=/.exec(output)![1]);
    terminals.close({ terminalId: opened.terminalId });
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive()).toBe(false);
  },
  20_000,
);

it.runIf(process.platform === "linux")(
  "lets exited shells give up their place to new ones",
  async () => {
    const terminals = createMobileTerminals();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const cwd = mkdtempSync(join(tmpdir(), "monocode-terminal-test-"));
      directories.push(cwd);
      const opened = terminals.open(cwd, {});
      ids.push(opened.terminalId);
      terminals.write({ terminalId: opened.terminalId, data: "exit\r" });
      for (let j = 0; j < 40; j++) {
        const read = await terminals.read({
          terminalId: opened.terminalId,
          cursor: 0,
          timeoutMs: 0,
        });
        if (!read.alive) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(new Set(ids).size).toBe(9);
  },
  60_000,
);
