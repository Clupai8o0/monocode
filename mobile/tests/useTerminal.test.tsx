import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminal } from "@/features/terminal/useTerminal";

const host = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("@/features/connection/ConnectionProvider", () => ({
  useConnection: () => ({ command: host.command }),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const read = (output: string, cursor: number, alive = true) => ({
  terminalId: "t1",
  output,
  cursor,
  dropped: false,
  alive,
  exitCode: alive ? null : 0,
});

describe("terminal hook", () => {
  let root: ReturnType<typeof createRoot>;
  let terminal: ReturnType<typeof useTerminal>;
  function Probe() {
    terminal = useTerminal("project", undefined, { cols: 50, rows: 30 });
    return null;
  }
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  beforeEach(() => {
    vi.clearAllMocks();
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => act(() => root.unmount()));

  it("opens the project's shell, follows its output and stops when it exits", async () => {
    host.command.mockImplementation(async (method: string) => {
      if (method === "terminal.open") return read("$ ", 2);
      if (method === "terminal.read") return read("ls\r\na.txt\n", 12, false);
      return {};
    });
    await act(async () => root.render(<Probe />));
    await flush();
    expect(host.command).toHaveBeenNthCalledWith(1, "terminal.open", {
      projectId: "project",
      cols: 50,
      rows: 30,
    });
    expect(host.command).toHaveBeenNthCalledWith(2, "terminal.read", {
      terminalId: "t1",
      cursor: 2,
      timeoutMs: 15_000,
    });
    expect(terminal.text.lines).toEqual(["$ ls", "a.txt", ""]);
    expect(terminal.alive).toBe(false);
    expect(terminal.exitCode).toBe(0);
    expect(host.command).toHaveBeenCalledTimes(2);

    await act(() => terminal.send("pwd\r"));
    expect(host.command).toHaveBeenLastCalledWith("terminal.write", {
      terminalId: "t1",
      data: "pwd\r",
    });
  });

  it("counts a shell that never started as stopped, so it can be restarted", async () => {
    host.command.mockResolvedValueOnce({
      ...read("spawn script ENOENT\n", 20, false),
      exitCode: null,
    });
    await act(async () => root.render(<Probe />));
    await flush();
    expect(terminal.started).toBe(true);
    expect(terminal.alive).toBe(false);
    expect(terminal.exitCode).toBeNull();
  });

  it("sends writes one after another, in order", async () => {
    const order: string[] = [];
    let release!: () => void;
    host.command.mockImplementation(async (method: string, params: { data?: string }) => {
      if (method === "terminal.open") return read("$ ", 2);
      if (method === "terminal.read") return new Promise(() => {});
      if (params.data === "sleep 5\r")
        await new Promise<void>((resolve) => (release = resolve));
      order.push(params.data!);
      return {};
    });
    await act(async () => root.render(<Probe />));
    await flush();
    let both!: Promise<unknown>;
    act(() => {
      both = Promise.all([terminal.send("sleep 5\r"), terminal.send("\x03")]);
    });
    await flush();
    expect(order).toEqual([]);
    release();
    await act(() => both);
    expect(order).toEqual(["sleep 5\r", "\x03"]);
  });

  it("starts over with a fresh screen on restart", async () => {
    let opens = 0;
    host.command.mockImplementation(async (method: string) => {
      if (method === "terminal.open")
        return read(opens++ ? "new\n" : "old\n", 4, false);
      return {};
    });
    await act(async () => root.render(<Probe />));
    await flush();
    expect(terminal.text.lines).toEqual(["old", ""]);
    act(() => terminal.restart());
    await flush();
    expect(terminal.text.lines).toEqual(["new", ""]);
  });
});
