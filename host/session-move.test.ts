import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  truncateSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  PACK_MAX_BYTES,
  type CheckResult,
  type InspectResult,
  type MoveManifest,
} from "../src/fork/sessionMove/sessionMoveProtocol";
import {
  accountHasRoom,
  handleSessionMove,
  runGrouped,
  runsClaude,
  windowEnv,
  within,
  type SessionMoveEnv,
} from "./session-move";
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
    commandLine: async () => ["claude", "--resume", "x"],
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
    expect(cwd).toBe(join(realpathSync(targetRepo), ".claude/worktrees/moved-my-session"));
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

  it("keeps an unfinished move's record however old, and refuses one it can't read", async () => {
    const { manifest, urls } = await carry();
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    const later: SessionMoveEnv = { ...targetEnv, now: () => Date.now() + 48 * 3_600_000 };
    await handleSessionMove(later, { op: "check", sourcePath: source, urls });
    const record = join(targetHome, "staging", MOVE, "made.json");
    expect(existsSync(record)).toBe(true);

    writeFileSync(record, '{"repo":"/x"');
    await expect(handleSessionMove(targetEnv, { op: "undo", moveId: MOVE })).rejects.toThrow();
    expect(existsSync(cwd)).toBe(true);
  });

  it("drops an abandoned pack that has no record", async () => {
    await carry();
    const later: SessionMoveEnv = { ...sourceEnv, now: () => Date.now() + 48 * 3_600_000 };
    await handleSessionMove(later, { op: "check", sourcePath: source, urls: ["https://example.com/x"] });
    expect(existsSync(join(sourceEnv.home, "staging", MOVE))).toBe(false);
  });

  it("works from the real path when the project is reached through a link", async () => {
    const { manifest, urls } = await carry();
    const link = join(base, "link-to-repo");
    symlinkSync(targetRepo, link);
    const viaLink: SessionMoveEnv = { ...targetEnv, projects: () => [link] };
    rmSync(join(targetHome, "Documents"), { recursive: true, force: true, maxRetries: 0 });
    mkdirSync(dirname(targetRepo), { recursive: true });
    execFileSync("git", ["clone", "--quiet", origin, targetRepo], { stdio: "ignore" });
    const { cwd, repo } = (await handleSessionMove(viaLink, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string; repo: string };
    expect(repo).toBe(realpathSync(targetRepo));
    expect(cwd.startsWith(realpathSync(targetRepo))).toBe(true);
  });

  it("takes the newest copy when both accounts hold the conversation", async () => {
    const convo = conversation(sourceEnv.home, source);
    const other = conversation(sourceEnv.home, source, ".claude-exec");
    mkdirSync(dirname(other.transcript), { recursive: true });
    writeFileSync(other.transcript, '{"turn":2}\n');
    utimesSync(convo.transcript, 1000, 1000);
    const facts = (await handleSessionMove(sourceEnv, { op: "inspect", cwd: source, sessionId: ID })) as InspectResult;
    expect(facts.account).toBe("cx");
    const manifest = (await handleSessionMove(sourceEnv, {
      op: "pack", moveId: MOVE, cwd: source, sessionId: ID, remoteName: "origin",
    })) as MoveManifest;
    const packed = join(sourceEnv.home, "staging", MOVE, `convo/session/${ID}.jsonl`);
    expect(readFileSync(packed, "utf8")).toBe('{"turn":2}\n');
    expect(manifest.files.some((file) => file.path.endsWith(`${ID}.jsonl`))).toBe(true);
  });

  it("runs long steps as begin and poll, undo after what is running", async () => {
    const { manifest, urls } = await carry();
    const order: string[] = [];
    const slow: SessionMoveEnv = {
      ...targetEnv,
      run: async (command, args, options) => {
        if (args.includes("worktree") && args.includes("add")) order.push("add");
        if (args.includes("worktree") && args.includes("remove")) order.push("remove");
        return runCommand(command, args, options);
      },
    };
    const poll = async (inner: string) => {
      for (;;) {
        const answer = (await handleSessionMove(slow, { op: "poll", moveId: MOVE, inner })) as {
          done: boolean; result?: unknown; error?: string;
        };
        if (answer.done) return answer;
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    await expect(handleSessionMove(slow, { op: "poll", moveId: MOVE, inner: "unpackCode" })).rejects.toThrow(/restarted/);
    await handleSessionMove(slow, {
      op: "begin",
      inner: { op: "unpackCode", moveId: MOVE, name: "s", manifest, urls },
    });
    await handleSessionMove(slow, { op: "begin", inner: { op: "undo", moveId: MOVE } });
    const answer = await poll("undo");
    expect(answer.error).toBeUndefined();
    expect(order).toEqual(["add", "remove"]);
    expect(existsSync(join(targetRepo, ".claude/worktrees/moved-s"))).toBe(false);
    await expect(handleSessionMove(slow, { op: "begin", inner: { op: "read", moveId: MOVE } })).rejects.toThrow(/Unsupported/);
  });

  it("answers a repeated poll the same, until the move is done", async () => {
    const { manifest, urls } = await carry();
    await handleSessionMove(targetEnv, {
      op: "begin",
      inner: { op: "unpackCode", moveId: MOVE, name: "s", manifest, urls },
    });
    let first: { done: boolean; result?: unknown; error?: string };
    for (;;) {
      first = (await handleSessionMove(targetEnv, { op: "poll", moveId: MOVE, inner: "unpackCode" })) as typeof first;
      if (first.done) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    expect(first.error).toBeUndefined();
    // The reply was lost: asking again must not read as a restart.
    expect(await handleSessionMove(targetEnv, { op: "poll", moveId: MOVE, inner: "unpackCode" })).toEqual(first);
    await handleSessionMove(targetEnv, { op: "done", moveId: MOVE });
    await expect(
      handleSessionMove(targetEnv, { op: "poll", moveId: MOVE, inner: "unpackCode" }),
    ).rejects.toThrow(/restarted/);
  });

  it("undo won't remove anything while the copy there refuses to stop", async () => {
    const { manifest, urls, account } = await carry();
    const bin = join(targetHome, ".local/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "lab-session"), "#!/bin/bash\necho started\n");
    chmodSync(join(bin, "lab-session"), 0o755);
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    await handleSessionMove(targetEnv, { op: "unpackConversation", moveId: MOVE, manifest, account });
    await handleSessionMove(targetEnv, { op: "start", moveId: MOVE, sessionId: ID, name: "s" });
    const dir = join(targetHome, ".claude/sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: ID, cwd, status: "idle" }));
    const stubborn: SessionMoveEnv = { ...targetEnv, isAlive: () => true };
    await expect(handleSessionMove(stubborn, { op: "undo", moveId: MOVE })).rejects.toThrow(/would not stop/);
    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(conversation(targetHome, cwd).transcript)).toBe(true);
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
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    // main is over the cap, so it lands on cx although it came from main.
    await expect(
      handleSessionMove(targetEnv, { op: "unpackConversation", moveId: MOVE, manifest, account: "main" }),
    ).resolves.toEqual({ account: "cx" });

    const started = await handleSessionMove(targetEnv, { op: "start", moveId: MOVE, sessionId: ID, name: "taken" });
    expect(started).toEqual({ name: "taken-2" });
    const calls = readFileSync(logFile, "utf8");
    expect(calls).toContain(`--resume '${ID}'`);
    expect(calls).toContain("CLAUDE_ACCT=cx");

    await expect(handleSessionMove(targetEnv, { op: "confirm", moveId: MOVE, sessionId: ID, name: "queued-one" })).resolves.toEqual({ state: "queued" });
    fake("agent-gate", `printf "agent-gate: 1 of 10\\n\\n  pos  name\\n  1    ${"a".repeat(40)} 1 1s 1 x\\n"`);
    await expect(handleSessionMove(targetEnv, { op: "confirm", moveId: MOVE, sessionId: ID, name: "a".repeat(48) })).resolves.toEqual({ state: "queued" });
    const dir = join(targetHome, ".claude-exec/sessions");
    mkdirSync(dir, { recursive: true });
    // Another process on the conversation, elsewhere, is not this move's copy.
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: ID, cwd: "x", name: "other", status: "idle" }));
    const elsewhere = (await handleSessionMove(targetEnv, { op: "confirm", moveId: MOVE, sessionId: ID, name: "taken-2" })) as { state: string };
    expect(elsewhere.state).not.toBe("up");
    // And with one live, a start refuses rather than run a second.
    await expect(
      handleSessionMove(targetEnv, { op: "start", moveId: MOVE, sessionId: ID, name: "again" }),
    ).rejects.toThrow(/already running/);
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: ID, cwd, status: "idle" }));
    await expect(handleSessionMove(targetEnv, { op: "confirm", moveId: MOVE, sessionId: ID, name: "taken-2" })).resolves.toEqual({ state: "up" });
  });

  /** Unpacked and started, with a fake lab-session; the copy's folder. */
  const started = async () => {
    const bin = join(targetHome, ".local/bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "lab-session"), "#!/bin/bash\necho started\n");
    chmodSync(join(bin, "lab-session"), 0o755);
    const { manifest, urls, account } = await carry();
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    await handleSessionMove(targetEnv, { op: "unpackConversation", moveId: MOVE, manifest, account });
    await handleSessionMove(targetEnv, { op: "start", moveId: MOVE, sessionId: ID, name: "s" });
    return { cwd, manifest };
  };

  const withTmux = (
    answer: { code: number | null; stderr: string; timedOut: boolean; stdout?: string },
    base: SessionMoveEnv = targetEnv,
  ): SessionMoveEnv => ({
    ...base,
    run: async (command, args, options) =>
      command === "tmux" ? { stdout: "", ...answer } : base.run(command, args, options),
  });

  it("undo keeps everything when the windows there can't be listed", async () => {
    const { cwd } = await started();
    const slow = withTmux({ code: null, stderr: "", timedOut: true });
    await expect(handleSessionMove(slow, { op: "undo", moveId: MOVE })).rejects.toThrow(/Could not list/);
    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(conversation(targetHome, cwd).transcript)).toBe(true);
    expect(existsSync(join(targetHome, "staging", MOVE, "made.json"))).toBe(true);
    // A server it may not reach is not an absent one.
    const denied = withTmux({ code: 1, stderr: "error connecting to /tmp/tmux-1000/default (Permission denied)", timedOut: false });
    await expect(handleSessionMove(denied, { op: "undo", moveId: MOVE })).rejects.toThrow(/Could not list/);
    expect(existsSync(cwd)).toBe(true);
    // No lab session at all is an answer: nothing is running there.
    const none = withTmux({ code: 1, stderr: "can't find session: lab", timedOut: false });
    await handleSessionMove(none, { op: "undo", moveId: MOVE });
    expect(existsSync(cwd)).toBe(false);
  });

  it("a repeated start gets the launch already made", async () => {
    const { cwd } = await started();
    const calls = join(base, "starts");
    writeFileSync(join(targetHome, ".local/bin/lab-session"), `#!/bin/bash\necho "$3" >> '${calls}'\n`);
    const up = withTmux({ code: 0, stderr: "", timedOut: false, stdout: `s\t${cwd}\n` });
    await expect(handleSessionMove(up, { op: "start", moveId: MOVE, sessionId: ID, name: "s" })).resolves.toEqual({ name: "s" });
    expect(existsSync(calls)).toBe(false);
  });

  it("a move that crashed before its add leaves the name reserved, and its undo takes nothing else", async () => {
    const { manifest, urls } = await carry();
    const crashing: SessionMoveEnv = {
      ...targetEnv,
      run: async (command, args, options) => {
        if (args.includes("worktree") && args.includes("add")) throw new Error("crashed");
        return runCommand(command, args, options);
      },
    };
    await expect(
      handleSessionMove(crashing, { op: "unpackCode", moveId: MOVE, name: "s", manifest, urls }),
    ).rejects.toThrow(/crashed/);
    const other = "move-0002-abcdef";
    for (const file of manifest.files) {
      const from = join(targetHome, "staging", MOVE, file.path);
      mkdirSync(dirname(join(targetHome, "staging", other, file.path)), { recursive: true });
      writeFileSync(join(targetHome, "staging", other, file.path), readFileSync(from));
    }
    const second = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: other, name: "s", manifest, urls,
    })) as { cwd: string; branch: string };
    expect(second.branch).toBe("moved/s-2");
    await handleSessionMove(targetEnv, { op: "undo", moveId: MOVE });
    expect(existsSync(second.cwd)).toBe(true);
    expect(existsSync(join(targetRepo, ".claude/worktrees/moved-s"))).toBe(false);
  });

  it("refuses a link from outside upwork into a client repository, and keeps Panoptic", async () => {
    const facts = (await handleSessionMove(sourceEnv, { op: "inspect", cwd: source, sessionId: ID })) as InspectResult;
    const urls = facts.remotes.map((remote) => remote.url);
    rmSync(targetRepo, { recursive: true, force: true });
    const client = join(targetHome, "Documents/projects/upwork/acme");
    mkdirSync(dirname(client), { recursive: true });
    execFileSync("git", ["clone", "--quiet", origin, client], { stdio: "ignore" });
    const link = join(targetHome, "Documents/projects/app");
    symlinkSync(client, link);
    const viaLink: SessionMoveEnv = { ...targetEnv, projects: () => [link] };
    await expect(handleSessionMove(viaLink, { op: "check", sourcePath: source, urls })).resolves.toEqual({
      ok: false,
      reason: "Client work stays on the Mac",
    });
    const panoptic = join(targetHome, "Documents/projects/upwork/panoptic/app");
    mkdirSync(dirname(panoptic), { recursive: true });
    rmSync(client, { recursive: true, force: true });
    unlinkSync(link);
    execFileSync("git", ["clone", "--quiet", origin, panoptic], { stdio: "ignore" });
    symlinkSync(panoptic, link);
    await expect(handleSessionMove(viaLink, { op: "check", sourcePath: source, urls })).resolves.toMatchObject({ ok: true });
  });

  it("undo removes a worktree whose add it never heard back from, only if it is unchanged", async () => {
    const { manifest, urls } = await carry();
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    const record = join(targetHome, "staging", MOVE, "made.json");
    // As if it crashed between the add and saving that it worked.
    const crashed = () => {
      const made = JSON.parse(readFileSync(record, "utf8"));
      made.pending = { worktree: made.worktree, branch: made.branch, head: manifest.head };
      delete made.worktree;
      delete made.branch;
      writeFileSync(record, JSON.stringify(made));
    };
    crashed();
    await handleSessionMove(targetEnv, { op: "undo", moveId: MOVE });
    expect(existsSync(cwd)).toBe(false);
    expect(sh(targetRepo, "branch", "--list", "moved/s")).toBe("");

    // A branch that has moved on is someone's work, not this move's.
    const again = await carry();
    const second = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest: again.manifest, urls,
    })) as { cwd: string };
    crashed();
    writeFileSync(join(second.cwd, "work.txt"), "mine\n");
    sh(second.cwd, "add", "work.txt");
    execFileSync("git", ["-C", second.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"]);
    await handleSessionMove(targetEnv, { op: "undo", moveId: MOVE });
    expect(existsSync(join(second.cwd, "work.txt"))).toBe(true);
    expect(sh(targetRepo, "branch", "--list", "moved/s")).toContain("moved/s");
  });

  it("stops before copying past the size limit", async () => {
    // Sparse: as big as that on paper, nothing on the disk.
    writeFileSync(join(source, "big.bin"), "");
    truncateSync(join(source, "big.bin"), PACK_MAX_BYTES + 1);
    await expect(
      handleSessionMove(sourceEnv, { op: "pack", moveId: MOVE, cwd: source, sessionId: ID, remoteName: "origin" }),
    ).rejects.toThrow(/over 2 GB/);
    expect(existsSync(join(sourceEnv.stagingRoot, MOVE, "untracked", "big.bin"))).toBe(false);
  });

  it("undo keeps a confirmed worktree once new commits are made in it", async () => {
    const { manifest, urls } = await carry();
    const { cwd } = (await handleSessionMove(targetEnv, {
      op: "unpackCode", moveId: MOVE, name: "s", manifest, urls,
    })) as { cwd: string };
    writeFileSync(join(cwd, "work.txt"), "mine\n");
    sh(cwd, "add", "work.txt");
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "work"]);
    const undone = (await handleSessionMove(targetEnv, { op: "undo", moveId: MOVE })) as { kept?: string };
    expect(undone.kept).toContain(cwd);
    expect(existsSync(join(cwd, "work.txt"))).toBe(true);
    expect(sh(targetRepo, "branch", "--list", "moved/s")).toContain("moved/s");
    expect(existsSync(join(targetHome, "staging", MOVE))).toBe(false);
  });

  it("won't stop a conversation two processes have open", async () => {
    const dir = join(targetHome, ".claude/sessions");
    mkdirSync(dir, { recursive: true });
    for (const pid of [4242, 4343])
      writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: ID, cwd: targetRepo, status: "idle", statusUpdatedAt: 0 }));
    const signals: number[] = [];
    const both: SessionMoveEnv = { ...targetEnv, isAlive: () => true, kill: (pid) => void signals.push(pid) };
    await expect(handleSessionMove(both, { op: "state", sessionId: ID })).rejects.toThrow(/open twice/);
    await expect(handleSessionMove(both, { op: "stop", sessionId: ID })).resolves.toEqual({ stopped: false });
    expect(signals).toEqual([]);
  });

  it("signals a PID with no start stamp only when it is still Claude", async () => {
    const dir = join(targetHome, ".claude/sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ pid: 4242, sessionId: ID, cwd: targetRepo, status: "idle", statusUpdatedAt: 0 }));
    const signals: string[] = [];
    const as = (line: string | null): SessionMoveEnv => ({
      ...targetEnv,
      commandLine: async () => (line === null ? null : line.split(" ")),
      kill: (_pid, signal) => signals.push(signal),
    });
    // Reused by something else: the session is gone, and nothing is signalled.
    await expect(handleSessionMove(as("node server.js"), { op: "stop", sessionId: ID })).resolves.toEqual({ stopped: true });
    // Can't tell: refused.
    await expect(handleSessionMove(as(null), { op: "stop", sessionId: ID })).resolves.toEqual({ stopped: false });
    // Naming the launcher in its arguments doesn't make an editor Claude.
    await expect(
      handleSessionMove(as("vim /home/me/.local/bin/claude-acct"), { op: "stop", sessionId: ID }),
    ).resolves.toEqual({ stopped: true });
    expect(signals).toEqual([]);
    let alive = true;
    const claude: SessionMoveEnv = {
      ...as("/usr/bin/claude --resume x"),
      isAlive: () => alive,
      kill: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
    };
    await expect(handleSessionMove(claude, { op: "stop", sessionId: ID })).resolves.toEqual({ stopped: true });
    expect(signals).toEqual(["SIGTERM"]);
  });
});

describe("within", () => {
  it("holds the folder and what is inside it, not a longer name", () => {
    expect(within("Documents/projects/app", "Documents/projects/app")).toBe(true);
    expect(within("Documents/projects/app/sub", "Documents/projects/app")).toBe(true);
    expect(within("Documents/projects/application", "Documents/projects/app")).toBe(false);
  });
});

describe("windowEnv", () => {
  it("adds the user bus a service lacks, and the lab's commands", () => {
    const next = windowEnv("/home/me", { PATH: "/usr/bin" });
    expect(next.PATH).toBe("/home/me/.local/bin:/usr/bin");
    if (process.getuid) expect(next.DBUS_SESSION_BUS_ADDRESS).toMatch(/^unix:path=/);
  });
});

describe("runGrouped", () => {
  it("gives up on a helper that holds git's output past the deadline", async () => {
    const started = Date.now();
    const result = await runGrouped("git", ["-c", "alias.hang=!sleep 30 &", "hang"], { timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("answers a command that ends normally", async () => {
    await expect(runGrouped("git", ["--version"], { timeoutMs: 10_000 })).resolves.toMatchObject({ code: 0, timedOut: false });
  });
});

describe("runsClaude", () => {
  it("is the program that runs, not a word in its arguments", () => {
    expect(runsClaude(["claude", "--resume", "x"])).toBe(true);
    expect(runsClaude(["/home/me/.local/share/claude/versions/2.1.3", "--resume", "x"])).toBe(true);
    expect(runsClaude(["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"])).toBe(true);
    expect(runsClaude(["/bin/bash", "/home/me/.local/bin/claude-acct", "run"])).toBe(true);
    expect(runsClaude(["vim", "/home/me/.local/bin/claude-acct"])).toBe(false);
    expect(runsClaude(["less", "claude"])).toBe(false);
    expect(runsClaude(["bash", "-c", "claude"])).toBe(false);
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
      commandLine: async () => null,
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
      commandLine: async () => null,
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
