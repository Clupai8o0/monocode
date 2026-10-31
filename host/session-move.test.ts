import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  type CheckResult,
  type InspectResult,
  type MoveManifest,
} from "../src/fork/sessionMove/sessionMoveProtocol";
import { accountHasRoom, handleSessionMove, type SessionMoveEnv } from "./session-move";
import { runCommand } from "./lab-system";

const ID = "11111111-2222-3333-4444-555555555555";
const MOVE = "move-0001-abcdef";

function sh(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

/** Every file under a folder, as path -> content digest or link target. */
function tree(root: string, skip: (rel: string) => boolean = () => false) {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (rel === ".git" || skip(rel)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) out[rel] = `link:${readlinkSync(path)}`;
      else if (info.isDirectory()) walk(path);
      else
        out[rel] = `${info.mode & 0o111 ? "x" : "-"}${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  };
  walk(root);
  return out;
}

describe("session move, a real run with two home folders", () => {
  let base: string;
  let source: string;
  let targetHome: string;
  let origin: string;
  let targetRepo: string;
  let sourceEnv: SessionMoveEnv;
  let targetEnv: SessionMoveEnv;

  const env = (home: string): SessionMoveEnv => ({
    home,
    stagingRoot: join(home, "staging"),
    run: runCommand,
    projects: () => [],
    isAlive: (pid) => pid === 4242,
    kill: () => {},
    sleep: async () => {},
    now: () => 1_000_000,
  });

  const conversation = (home: string, cwd: string, account = ".claude") => {
    const key = cwd.replace(/[^A-Za-z0-9]/g, "-");
    return {
      transcript: join(home, account, "projects", key, `${ID}.jsonl`),
      subagent: join(home, account, "projects", key, ID, "subagents", "agent-1.jsonl"),
      history: join(home, account, "file-history", ID, "v1"),
    };
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "session-move-"));
    origin = join(base, "origin.git");
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    const sourceHome = join(base, "mac");
    targetHome = join(base, "lab");
    source = join(sourceHome, "Documents/projects/app");
    targetRepo = join(targetHome, "Documents/projects/app");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(targetRepo), { recursive: true });
    execFileSync("git", ["clone", "--quiet", origin, source], { stdio: "ignore" });
    sh(source, "checkout", "-q", "-b", "main");
    writeFileSync(join(source, "keep.txt"), "keep\n");
    writeFileSync(join(source, "edit.txt"), "one\ntwo\n");
    writeFileSync(join(source, "gone.txt"), "bye\n");
    writeFileSync(join(source, ".gitignore"), ".env\nnode_modules/\n");
    writeFileSync(join(source, "logo.bin"), Buffer.from([0, 1, 2, 3, 255, 0]));
    sh(source, "add", ".");
    sh(source, "commit", "-q", "-m", "first");
    sh(source, "push", "-q", "origin", "main");
    execFileSync("git", ["clone", "--quiet", origin, targetRepo], { stdio: "ignore" });
    sourceEnv = env(sourceHome);
    targetEnv = env(targetHome);

    const convo = conversation(sourceHome, source);
    for (const file of Object.values(convo)) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(convo.transcript, '{"turn":1}\n');
    writeFileSync(convo.subagent, "sub\n");
    writeFileSync(convo.history, "v1\n");
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A local-only commit, an edit, a deletion, binary, new, link and ignored files. */
  const dirty = () => {
    writeFileSync(join(source, "local.txt"), "only here\n");
    sh(source, "add", ".");
    sh(source, "commit", "-q", "-m", "local only");
    writeFileSync(join(source, "edit.txt"), "one\nchanged\n");
    unlinkSync(join(source, "gone.txt"));
    writeFileSync(join(source, "logo.bin"), Buffer.from([9, 0, 8, 0, 7, 255]));
    writeFileSync(join(source, "staged.txt"), "staged\n");
    sh(source, "add", "staged.txt");
    mkdirSync(join(source, "new/deep"), { recursive: true });
    writeFileSync(join(source, "new/deep/file with space.bin"), Buffer.from([0, 255, 0]));
    writeFileSync(join(source, "new/empty"), "");
    writeFileSync(join(source, "new/run.sh"), "#!/bin/sh\n");
    chmodSync(join(source, "new/run.sh"), 0o755);
    symlinkSync("keep.txt", join(source, "new/link"));
    writeFileSync(join(source, ".env"), "SECRET=1\n");
    mkdirSync(join(source, "node_modules"));
    writeFileSync(join(source, "node_modules/x"), "x");
  };

  const carry = async (from = sourceEnv, to = targetEnv, cwd = source) => {
    const facts = (await handleSessionMove(from, { op: "inspect", cwd, sessionId: ID })) as InspectResult;
    const checked = (await handleSessionMove(to, {
      op: "check",
      sourcePath: cwd,
      urls: facts.remotes.map((remote) => remote.url),
    })) as CheckResult;
    if (!checked.ok) throw new Error(checked.reason);
    const manifest = (await handleSessionMove(from, {
      op: "pack", moveId: MOVE, cwd, sessionId: ID, remoteName: facts.remotes[0].name,
    })) as MoveManifest;
    for (const file of manifest.files) {
      let offset = 0;
      if (file.size === 0) {
        await handleSessionMove(to, { op: "write", moveId: MOVE, sessionId: ID, path: file.path, offset, data: "" });
      }
      while (offset < file.size) {
        const { data } = (await handleSessionMove(from, { op: "read", moveId: MOVE, path: file.path, offset })) as { data: string };
        await handleSessionMove(to, { op: "write", moveId: MOVE, sessionId: ID, path: file.path, offset, data });
        offset += Buffer.from(data, "base64").length;
      }
    }
    return { manifest, urls: facts.remotes.map((remote) => remote.url), account: facts.account };
  };

  it("carries a dirty tree, a deletion, binary files and a local commit byte for byte", async () => {
    dirty();
    const { manifest, urls, account } = await carry();
    const { cwd, branch } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "my-session", manifest, urls,
    })) as { cwd: string; branch: string };
    expect(branch).toBe("moved/my-session");
    expect(cwd).toBe(join(targetRepo, ".claude/worktrees/moved-my-session"));
    await handleSessionMove(targetEnv, { op: "unpackConversation", moveId: MOVE, manifest, account });

    const ignored = (rel: string) => rel === ".env" || rel.startsWith("node_modules");
    const carried = tree(cwd);
    expect(carried).toEqual(tree(source, ignored));
    expect(carried[".env"]).toBeUndefined();
    expect(existsSync(join(cwd, "gone.txt"))).toBe(false);
    expect(readlinkSync(join(cwd, "new/link"))).toBe("keep.txt");
    expect(sh(cwd, "rev-parse", "HEAD")).toBe(sh(source, "rev-parse", "HEAD"));
    expect(sh(cwd, "log", "-1", "--format=%s")).toBe("local only");

    // Names only, never contents.
    expect(manifest.ignored).toEqual(expect.arrayContaining([".env", "node_modules/"]));
    expect(JSON.stringify(manifest)).not.toContain("SECRET");
    const packed = manifest.files.map((file) => file.path);
    expect(packed).not.toContain("untracked/.env");

    const from = conversation(sourceEnv.home, source);
    const to = conversation(targetHome, cwd);
    expect(readFileSync(to.transcript)).toEqual(readFileSync(from.transcript));
    expect(readFileSync(to.subagent)).toEqual(readFileSync(from.subagent));
    expect(readFileSync(to.history)).toEqual(readFileSync(from.history));
    // The original is left as it was.
    expect(readFileSync(join(source, "edit.txt"), "utf8")).toBe("one\nchanged\n");
    expect(existsSync(from.transcript)).toBe(true);
  });

  it("needs no bundle when nothing is local, and a large file comes in pieces", async () => {
    const big = Buffer.alloc(CHUNK_BYTES * 2 + 17, 7);
    writeFileSync(join(source, "big.bin"), big);
    const { manifest, urls, account } = await carry();
    expect(manifest.files.map((file) => file.path)).not.toContain("commits.bundle");
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    await handleSessionMove(targetEnv, { op: "unpackConversation", moveId: MOVE, manifest, account });
    expect(readFileSync(join(cwd, "big.bin")).equals(big)).toBe(true);
  });

  it("takes the next free name on a second trip", async () => {
    const first = await carry();
    await handleSessionMove(targetEnv, { op: "unpackCode", moveId: MOVE, name: "s", manifest: first.manifest, urls: first.urls });
    const second = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest: first.manifest, urls: first.urls,
    })) as { cwd: string; branch: string };
    expect(second.branch).toBe("moved/s-2");
    expect(second.cwd.endsWith("moved-s-2")).toBe(true);
  });

  it("undo removes what the move made and nothing older", async () => {
    dirty();
    const { manifest, urls, account } = await carry();
    const older = join(targetHome, ".claude/file-history", ID, "older");
    mkdirSync(dirname(older), { recursive: true });
    writeFileSync(older, "older");
    // Carried over by this move, and put back by its undo.
    const replaced = join(targetHome, ".claude/file-history", ID, "v1");
    writeFileSync(replaced, "the older v1");
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    await handleSessionMove(targetEnv, { op: "unpackConversation", moveId: MOVE, manifest, account });
    const to = conversation(targetHome, cwd);
    expect(existsSync(to.transcript)).toBe(true);

    await handleSessionMove(targetEnv, { op: "undo", moveId: MOVE });

    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(to.transcript)).toBe(false);
    expect(readFileSync(to.history, "utf8")).toBe("the older v1");
    expect(readFileSync(older, "utf8")).toBe("older");
    expect(sh(targetRepo, "branch", "--list", "moved/s")).toBe("");
    expect(sh(targetRepo, "worktree", "list")).not.toContain("moved-s");
    expect(existsSync(join(targetHome, "staging", MOVE))).toBe(false);
  });

  it("a rollback leaves alone a worktree another move took first", async () => {
    const { manifest, urls } = await carry();
    let raced = "";
    const racing: SessionMoveEnv = {
      ...targetEnv,
      run: async (command, args, options) => {
        const at = args.indexOf("add");
        if (args.includes("worktree") && at >= 0 && !raced) {
          // The other move gets there between the name check and this add.
          raced = args[at + 4];
          sh(targetRepo, "worktree", "add", "-q", "-b", args[at + 3], raced, args[at + 5]);
        }
        return runCommand(command, args, options);
      },
    };
    await expect(
      handleSessionMove(racing, { op: "unpackCode", moveId: MOVE, name: "s", manifest, urls }),
    ).rejects.toThrow();
    await handleSessionMove(racing, { op: "undo", moveId: MOVE });
    expect(existsSync(raced)).toBe(true);
    expect(sh(targetRepo, "branch", "--list", "moved/s")).toContain("moved/s");
  });

  it("undo after a failed code step leaves no worktree", async () => {
    dirty();
    const { manifest, urls } = await carry();
    writeFileSync(join(targetHome, "staging", MOVE, "changes.patch"), "not a patch\n");
    await expect(
      handleSessionMove(targetEnv, { op: "unpackCode", moveId: MOVE, name: "s", manifest, urls }),
    ).rejects.toThrow(/did not arrive whole/);
    await handleSessionMove(targetEnv, { op: "undo", moveId: MOVE });
    expect(existsSync(join(targetRepo, ".claude/worktrees/moved-s"))).toBe(false);
  });

  it("refuses a repository the target doesn't have, and client work on both ends", async () => {
    const facts = (await handleSessionMove(sourceEnv, { op: "inspect", cwd: source, sessionId: ID })) as InspectResult;
    await expect(
      handleSessionMove(targetEnv, { op: "check", sourcePath: source, urls: ["https://example.com/other.git"] }),
    ).resolves.toEqual({ ok: false, reason: "This repository is not on that machine" });
    await expect(
      handleSessionMove(targetEnv, {
        op: "check",
        sourcePath: "/Users/me/Documents/projects/upwork/acme/app",
        urls: facts.remotes.map((remote) => remote.url),
      }),
    ).resolves.toEqual({ ok: false, reason: "Client work stays on the Mac" });

    // A client clone on the target is refused even if the source says otherwise.
    const client = join(targetHome, "Documents/projects/upwork/acme");
    mkdirSync(dirname(client), { recursive: true });
    rmSync(targetRepo, { recursive: true, force: true });
    execFileSync("git", ["clone", "--quiet", origin, client], { stdio: "ignore" });
    await expect(
      handleSessionMove(targetEnv, { op: "check", sourcePath: source, urls: facts.remotes.map((remote) => remote.url) }),
    ).resolves.toEqual({ ok: false, reason: "Client work stays on the Mac" });
  });

  it("rejects paths and ids from the other machine", async () => {
    for (const path of ["../x", "/etc/passwd", "untracked/../../x", "untracked/.git/config", "convo/session/other.jsonl", "elsewhere", "untracked"]) {
      await expect(
        handleSessionMove(targetEnv, { op: "write", moveId: MOVE, sessionId: ID, path, offset: 0, data: "eA==" }),
      ).rejects.toThrow(/Refused/);
    }
    await expect(handleSessionMove(targetEnv, { op: "write", moveId: "../..", sessionId: ID, path: "changes.patch", offset: 0, data: "eA==" })).rejects.toThrow(/Invalid move id/);
    await expect(handleSessionMove(targetEnv, { op: "write", moveId: MOVE, sessionId: "../x", path: "changes.patch", offset: 0, data: "eA==" })).rejects.toThrow(/Invalid session id/);
    await expect(handleSessionMove(targetEnv, { op: "write", moveId: MOVE, sessionId: ID, path: "changes.patch", offset: 5, data: "eA==" })).rejects.toThrow(/out of order/);
    await expect(handleSessionMove(targetEnv, { op: "nope" })).rejects.toThrow(/Unsupported/);
  });

  it("will not write through a carried link", async () => {
    const { manifest, urls } = await carry();
    const outside = join(base, "outside");
    mkdirSync(outside);
    const evil: MoveManifest = {
      ...manifest,
      links: [
        { path: "untracked/evil", target: outside },
        { path: "untracked/evil/x", target: "y" },
      ],
    };
    await expect(
      handleSessionMove(targetEnv, { op: "unpackCode", moveId: MOVE, name: "s", manifest: evil, urls }),
    ).rejects.toThrow(/through a link/);
    expect(existsSync(join(outside, "x"))).toBe(false);
    await handleSessionMove(targetEnv, { op: "undo", moveId: MOVE });
    expect(existsSync(join(targetRepo, ".claude/worktrees/moved-s"))).toBe(false);
  });

  it("reads and stops a lab session from its registry entry", async () => {
    const entry = (over: object) => {
      const dir = join(targetHome, ".claude-exec/sessions");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: ID, cwd: targetRepo, name: "lab-one", status: "idle", statusUpdatedAt: 0, ...over }));
    };
    await expect(handleSessionMove(targetEnv, { op: "state", sessionId: ID })).resolves.toEqual({ state: "gone" });
    entry({ status: "busy" });
    expect(await handleSessionMove(targetEnv, { op: "state", sessionId: ID })).toMatchObject({ state: "busy", name: "lab-one", account: "cx" });
    await expect(handleSessionMove(targetEnv, { op: "stop", sessionId: ID })).resolves.toEqual({ stopped: false });
    entry({ status: "waiting" });
    expect(await handleSessionMove(targetEnv, { op: "state", sessionId: ID })).toMatchObject({ state: "waiting" });
    // Idle only once it has settled.
    entry({ status: "idle", statusUpdatedAt: 999_000 });
    expect(await handleSessionMove(targetEnv, { op: "state", sessionId: ID })).toMatchObject({ state: "busy" });
    entry({ status: "idle", statusUpdatedAt: 1 });
    expect(await handleSessionMove(targetEnv, { op: "state", sessionId: ID })).toMatchObject({ state: "idle" });
    // A relay's copy of a session elsewhere is not this machine's.
    entry({ monocodeRelay: { machine: "mac" } });
    await expect(handleSessionMove(targetEnv, { op: "state", sessionId: ID })).resolves.toEqual({ state: "gone" });

    entry({ status: "idle", statusUpdatedAt: 1 });
    const signals: string[] = [];
    let alive = true;
    const stopping: SessionMoveEnv = {
      ...targetEnv,
      isAlive: () => alive,
      kill: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
    };
    await expect(handleSessionMove(stopping, { op: "stop", sessionId: ID })).resolves.toEqual({ stopped: true });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("starts through lab-session, and tells a queue from a failure", async () => {
    const bin = join(targetHome, ".local/bin");
    mkdirSync(bin, { recursive: true });
    const logFile = join(base, "calls");
    const fake = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> '${logFile}'\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    fake("claude-acct", 'if [ "$1" = status ]; then printf "acct login email 5-hour week sessions\\nmain yes a@b 1%% x 95%% y 0\\ncx   yes c@d 10%% x 20%% y 3\\n"; else echo cx; fi');
    fake("agent-gate", 'printf "agent-gate: 1 of 10 running, 1 waiting\\n\\n  pos  name gate-pid waiting est-GB held-by\\n  1    queued-one 1 1s 1 x\\n"');
    // Refuses the taken name first, as the real one does for a window that exists.
    fake("lab-session", `if [ "$3" = taken ]; then echo "lab-session: window already exists in lab" >&2; exit 1; fi; echo started`);

    const { manifest, urls } = await carry();
    await handleSessionMove(targetEnv, { op: "unpackCode", moveId: MOVE, name: "s", manifest, urls });
    // main is over the cap, so it lands on cx although it came from main.
    await expect(
      handleSessionMove(targetEnv, { op: "unpackConversation", moveId: MOVE, manifest, account: "main" }),
    ).resolves.toEqual({ account: "cx" });

    const started = await handleSessionMove(targetEnv, { op: "start", moveId: MOVE, sessionId: ID, name: "taken" });
    expect(started).toEqual({ name: "taken-2" });
    const calls = readFileSync(logFile, "utf8");
    expect(calls).toContain(`--resume '${ID}'`);
    expect(calls).toContain("CLAUDE_ACCT=cx");

    await expect(handleSessionMove(targetEnv, { op: "confirm", sessionId: ID, name: "queued-one" })).resolves.toEqual({ state: "queued" });
    fake("agent-gate", `printf "agent-gate: 1 of 10\\n\\n  pos  name\\n  1    ${"a".repeat(40)} 1 1s 1 x\\n"`);
    await expect(handleSessionMove(targetEnv, { op: "confirm", sessionId: ID, name: "a".repeat(48) })).resolves.toEqual({ state: "queued" });
    const dir = join(targetHome, ".claude-exec/sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: ID, cwd: "x", status: "idle" }));
    await expect(handleSessionMove(targetEnv, { op: "confirm", sessionId: ID, name: "taken-2" })).resolves.toEqual({ state: "up" });
  });
});

describe("accountHasRoom", () => {
  const status = [
    "acct  login     email                    5-hour             week               sessions",
    "main  yes       a@b.com         1% Oct 31 20:20   91% Nov 03 16:00  0",
    "cx    yes       c@d.com        17% Oct 31 20:00   63% Nov 04 13:00  10",
    "threshold 90%, moves only to an account below 85%",
  ].join("\n");
  it("reads the higher of the two limits", () => {
    expect(accountHasRoom(status, "main")).toBe(false);
    expect(accountHasRoom(status, "cx")).toBe(true);
  });
  it("needs a login and known usage", () => {
    expect(accountHasRoom("cx    no   -   -  -  0", "cx")).toBe(false);
    expect(accountHasRoom("", "main")).toBe(false);
  });
});

// A pack made on one side unpacks on the other. Run by hand with the Rust
// module's ignored tests: MOVE_INTEROP_OUT there, then MOVE_INTEROP_RUST_PACK here;
// MOVE_INTEROP_IN here, then `interop_unpack` there.
describe("packs between the Mac and a host", () => {
  const rustPack = process.env.MOVE_INTEROP_RUST_PACK;
  it.skipIf(!rustPack)("unpacks what the Mac packed", async () => {
    const base = rustPack as string;
    const lab = join(base, "lab");
    const to: SessionMoveEnv = {
      home: lab,
      stagingRoot: join(lab, "staging"),
      run: runCommand,
      projects: () => [],
      isAlive: () => false,
      kill: () => {},
      sleep: async () => {},
      now: Date.now,
    };
    const source = join(base, "mac/Documents/projects/app");
    const manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8")) as MoveManifest;
    const staged = join(base, "mac/staging", MOVE);
    for (const file of manifest.files) {
      const data = readFileSync(join(staged, file.path)).toString("base64");
      await handleSessionMove(to, { op: "write", moveId: MOVE, sessionId: ID, path: file.path, offset: 0, data });
    }
    const urls = [sh(source, "remote", "get-url", "origin")];
    const { cwd } = (await handleSessionMove(to, { op: "unpackCode", moveId: MOVE, name: "from-mac", manifest, urls })) as { cwd: string };
    await handleSessionMove(to, { op: "unpackConversation", moveId: MOVE, manifest, account: "main" });
    const ignored = (rel: string) => rel === ".env" || rel.startsWith("node_modules");
    expect(tree(cwd)).toEqual(tree(source, ignored));
  });

  const hostPack = process.env.MOVE_INTEROP_IN;
  it.skipIf(!hostPack)("packs for the Mac to unpack", async () => {
    const base = hostPack as string;
    const origin = join(base, "origin.git");
    const macHome = join(base, "host");
    const labHome = join(base, "lab");
    const source = join(macHome, "Documents/projects/app");
    const targetRepo = join(labHome, "Documents/projects/app");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(targetRepo), { recursive: true });
    execFileSync("git", ["init", "--quiet", "--bare", origin]);
    execFileSync("git", ["clone", "--quiet", origin, source], { stdio: "ignore" });
    sh(source, "checkout", "-q", "-b", "main");
    writeFileSync(join(source, "edit.txt"), "one\n");
    writeFileSync(join(source, "gone.txt"), "bye\n");
    sh(source, "add", ".");
    sh(source, "commit", "-q", "-m", "first");
    sh(source, "push", "-q", "origin", "main");
    execFileSync("git", ["clone", "--quiet", origin, targetRepo], { stdio: "ignore" });
    writeFileSync(join(source, "local.txt"), "local\n");
    sh(source, "add", ".");
    sh(source, "commit", "-q", "-m", "local");
    writeFileSync(join(source, "edit.txt"), "changed\n");
    unlinkSync(join(source, "gone.txt"));
    writeFileSync(join(source, "new.bin"), Buffer.from([0, 255, 0]));
    const project = join(macHome, ".claude/projects", source.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${ID}.jsonl`), "{}\n");
    const from: SessionMoveEnv = {
      home: macHome,
      stagingRoot: join(macHome, "staging"),
      run: runCommand,
      projects: () => [],
      isAlive: () => false,
      kill: () => {},
      sleep: async () => {},
      now: Date.now,
    };
    const manifest = (await handleSessionMove(from, { op: "pack", moveId: MOVE, cwd: source, sessionId: ID, remoteName: "origin" })) as MoveManifest;
    for (const file of manifest.files) {
      const to = join(labHome, "staging", MOVE, file.path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(macHome, "staging", MOVE, file.path)));
    }
    writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(base, "urls.json"), JSON.stringify([origin]));
  });
});
