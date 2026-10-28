import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostShows, agentBinScripts, runShowCommand, secretName } from "./shows";
import { parseOsRelease } from "./os-name";
import {
  SHOW_CHUNK_BYTES,
  SHOW_MAX_FILE_BYTES,
  SHOW_SPOOL_MAX_ITEMS,
  SHOW_TTL_MS,
  parseShowItem,
} from "../src/fork/shows/showsModel";

const exec = promisify(execFile);
const posix = process.platform !== "win32";

let root: string;
let home: string;
let work: string;
let clock: number;
let shows: HostShows;

const make = () =>
  new HostShows({
    dataDir: join(root, "data"),
    home,
    socketPath: join(root, "s.sock"),
    now: () => clock,
    projects: () => [
      { id: "outer", cwd: work },
      { id: "inner", cwd: join(work, "app") },
    ],
  });

beforeEach(() => {
  // Short: Unix socket paths have a ~104 byte limit on macOS.
  root = mkdtempSync(join(posix ? "/tmp" : tmpdir(), "mshow-"));
  home = join(root, "home");
  work = join(root, "work");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(work, "app"), { recursive: true });
  clock = 1_000_000;
  shows = make();
});

afterEach(() => {
  shows.close();
  rmSync(root, { recursive: true, force: true });
});

const file = (name: string, content = "hello") => {
  const path = join(work, name);
  writeFileSync(path, content);
  return path;
};

describe("adding", () => {
  it("spools a file privately and tags its project", async () => {
    const path = file("report.md");
    const result = await shows.add({ v: 1, kind: "file", path, cwd: join(work, "app", "src"), sessionId: "s1" });
    expect(result).toMatchObject({ ok: true, message: "Queued until the Mac connects: report.md" });
    const [item] = shows.items();
    expect(item).toMatchObject({ seq: 1, kind: "file", name: "report.md", size: 5, mime: "text/markdown", projectId: "inner", sessionId: "s1" });
    expect(parseShowItem(item)).toBeTruthy();
    if (posix) {
      expect(statSync(join(root, "data", "shows")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "data", "shows", item.id)).mode & 0o777).toBe(0o600);
    }
  });

  it("refuses secrets, symlinks to secrets, folders and big files", async () => {
    expect(secretName("id_ed25519.pub")).toBe(true);
    expect(secretName(".env.local")).toBe(true);
    expect(secretName("auth-token.json")).toBe(true);
    expect(secretName("notes.md")).toBe(false);
    const env = file(".env", "TOKEN=x");
    expect(await shows.add({ v: 1, kind: "file", path: env })).toEqual({ ok: false, error: "Not sent: .env looks like a secret." });
    const key = join(home, ".ssh", "config");
    writeFileSync(key, "x");
    const link = join(work, "innocent.txt");
    symlinkSync(key, link);
    expect(await shows.add({ v: 1, kind: "file", path: link })).toEqual({ ok: false, error: "Not sent: config looks like a secret." });
    expect(await shows.add({ v: 1, kind: "file", path: join(work, "app") })).toMatchObject({ ok: false, error: "Not sent: app is not a file." });
    const big = file("big.bin");
    writeFileSync(big, Buffer.alloc(SHOW_MAX_FILE_BYTES + 1));
    expect(await shows.add({ v: 1, kind: "file", path: big })).toMatchObject({ ok: false });
    expect(await shows.add({ v: 1, kind: "file", path: join(root, "data", "shows", "index.json") })).toMatchObject({ ok: false });
    expect(shows.items()).toHaveLength(0);
  });

  it("takes only http and https links, never fetched, one per minute", async () => {
    expect(await shows.add({ v: 1, kind: "url", url: "file:///etc/passwd" })).toMatchObject({ ok: false });
    expect(await shows.add({ v: 1, kind: "url", url: "javascript:alert(1)" })).toMatchObject({ ok: false });
    const first = await shows.add({ v: 1, kind: "url", url: "http://localhost:5173/" });
    const again = await shows.add({ v: 1, kind: "url", url: "http://localhost:5173/" });
    expect(first.ok && again.ok && first.id === again.id).toBe(true);
    expect(shows.items()).toHaveLength(1);
    expect(shows.items()[0]).toMatchObject({ kind: "url", name: "localhost:5173" });
  });

  it("replaces an older item for the same real path", async () => {
    const path = file("a.txt");
    await shows.add({ v: 1, kind: "file", path });
    await shows.add({ v: 1, kind: "file", path });
    expect(shows.items().map((item) => item.seq)).toEqual([2]);
  });

  it("caps adds per minute, item count and age", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await shows.add({ v: 1, kind: "url", url: `https://e.com/${i}` })).ok).toBe(true);
    }
    expect(await shows.add({ v: 1, kind: "url", url: "https://e.com/x" })).toEqual({ ok: false, error: "Not sent: too many at once; try again in a minute." });
    for (let round = 0; round < 3; round++) {
      clock += 61_000;
      for (let i = 0; i < 20; i++) {
        await shows.add({ v: 1, kind: "url", url: `https://e.com/${round}/${i}` });
      }
    }
    expect(shows.items()).toHaveLength(SHOW_SPOOL_MAX_ITEMS);
    clock += SHOW_TTL_MS + 1;
    shows.sweep();
    expect(shows.items()).toHaveLength(0);
  });
});

describe("next and read", () => {
  it("wakes a waiting desktop on add, and says it was sent", async () => {
    const waiting = shows.next({ after: 0, waitMs: 5000 });
    const result = await shows.add({ v: 1, kind: "file", path: file("r.pdf") });
    expect(result).toMatchObject({ message: "Sent to the Mac: r.pdf" });
    const answer = await waiting;
    expect(answer.items).toHaveLength(1);
    expect(answer.cursor).toBe(1);
  });

  it("times out empty and resets a stale epoch", async () => {
    const started = Date.now();
    const empty = await shows.next({ waitMs: 50 });
    expect(empty.items).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    await shows.add({ v: 1, kind: "url", url: "https://a.com" });
    expect((await shows.next({ after: 1, epoch: empty.epoch })).items).toEqual([]);
    expect((await shows.next({ after: 1, epoch: "other" })).items).toHaveLength(1);
  });

  it("keeps items and epoch across a restart", async () => {
    await shows.add({ v: 1, kind: "file", path: file("k.txt") });
    const epoch = shows.epoch;
    shows.close();
    shows = make();
    expect(shows.epoch).toBe(epoch);
    expect(shows.items()).toHaveLength(1);
  });

  it("reads a spooled file in chunks", async () => {
    const content = Buffer.alloc(SHOW_CHUNK_BYTES + 10, 7);
    const result = await shows.add({ v: 1, kind: "file", path: file("big.png", content.toString("latin1")) });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const first = await shows.read({ id: result.id, offset: 0 });
    expect(first.done).toBe(false);
    const second = await shows.read({ id: result.id, offset: SHOW_CHUNK_BYTES });
    expect(second.done).toBe(true);
    expect(Buffer.from(first.data + "", "base64").length + Buffer.from(second.data, "base64").length).toBe(content.length);
    await expect(shows.read({ id: "../index.json", offset: 0 })).rejects.toThrow();
    await expect(shows.read({ id: "nope", offset: 0 })).rejects.toThrow();
  });
});

describe.runIf(posix)("socket and shims", () => {
  it("round-trips through the CLI client, and reports a missing host", async () => {
    await shows.listen();
    expect(statSync(join(root, "s.sock")).mode & 0o777).toBe(0o600);
    file("notes.md");
    const lines: string[] = [];
    const run = (args: string[], socketPath = join(root, "s.sock")) =>
      runShowCommand(args, { cwd: work, env: { MONOCODE_SESSION_ID: "abc" }, socketPath, print: (line) => lines.push(line) });
    expect(await run(["notes.md", "--title", "Notes"])).toBe(0);
    expect(shows.items()[0]).toMatchObject({ name: "notes.md", title: "Notes", sessionId: "abc", projectId: "outer" });
    expect(await run([".env"])).toBe(1);
    expect(await run(["x"], join(root, "none.sock"))).toBe(2);
    expect(lines).toEqual([
      "Queued until the Mac connects: notes.md",
      "Not sent: .env looks like a secret.",
      "MonoCode host isn't running here, so nothing was sent.",
    ]);
  });

  it("removes a stale socket but not a live one", async () => {
    writeFileSync(join(root, "s.sock"), "");
    await shows.listen();
    await expect(make().listen()).rejects.toThrow(/already/);
  });

  it("passes xdg-open through to the real one with MONOCODE_SHOW=off", async () => {
    const bin = join(root, "bin");
    const real = join(root, "real");
    mkdirSync(bin);
    mkdirSync(real);
    for (const [name, content] of Object.entries(agentBinScripts(bin, process.execPath, "/nonexistent.mjs"))) {
      writeFileSync(join(bin, name), content);
      chmodSync(join(bin, name), 0o755);
    }
    for (const name of ["xdg-open", "open"]) {
      writeFileSync(join(real, name), `#!/bin/sh\necho "real $*" > ${join(root, "out")}\n`);
      chmodSync(join(real, name), 0o755);
    }
    const env = { PATH: `${bin}:${real}:/usr/bin:/bin`, MONOCODE_SHOW: "off", MONOCODE_SHOW_SOCKET: "/x" };
    await exec(join(bin, "xdg-open"), ["report.pdf"], { env });
    expect(readFileSync(join(root, "out"), "utf8")).toBe("real report.pdf\n");
    // Not reachable (exit 2) also falls back to the real one.
    writeFileSync(join(bin, "monocode-show"), "#!/bin/sh\nexit 2\n");
    await exec(join(bin, "open"), ["-a", "Preview", "b.pdf"], { env: { ...env, MONOCODE_SHOW: "" } });
    expect(readFileSync(join(root, "out"), "utf8")).toBe("real -a Preview b.pdf\n");
    await exec(join(bin, "xdg-open"), ["c.pdf"], { env: { ...env, MONOCODE_SHOW: "" } });
    expect(readFileSync(join(root, "out"), "utf8")).toBe("real c.pdf\n");
  });

  it("installs agent-bin and gives agents the env", async () => {
    const dir = shows.installAgentBin(process.execPath, "/h.mjs");
    expect(shows.agentEnv("s", "/usr/bin")).toEqual({});
    await shows.listen();
    expect(shows.agentEnv("s", "/usr/bin")).toEqual({
      PATH: `${dir}:/usr/bin`,
      MONOCODE_SHOW_SOCKET: join(root, "s.sock"),
      MONOCODE_SESSION_ID: "s",
      BROWSER: join(dir!, "xdg-open"),
    });
    expect(statSync(join(dir!, "monocode-show")).mode & 0o777).toBe(0o755);
  });
});

it("reads PRETTY_NAME", () => {
  expect(parseOsRelease('NAME="Fedora"\nPRETTY_NAME="Fedora Linux 44 (Workstation)"\n')).toBe("Fedora Linux 44 (Workstation)");
  expect(parseOsRelease("NAME=x\n")).toBeUndefined();
});
