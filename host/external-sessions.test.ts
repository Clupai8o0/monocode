import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  etimeSeconds,
  listExternalSessions,
  macProcStart,
  readExternalSession,
  readTranscriptPage,
  transcriptTurns,
  type ExternalSessionsOptions,
} from "./external-sessions";

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function record(home: string, dir: string, file: string, value: object) {
  write(join(home, dir, file), JSON.stringify(value));
}

function setup(alive: number[] = []) {
  const home = temp("ext-home-");
  const project = temp("ext-proj-");
  const projects = [{ id: "p1", path: project }];
  const options: ExternalSessionsOptions = {
    home,
    now: () => NOW,
    platform: "linux",
    isAlive: (pid) => alive.includes(pid),
    gitCommonDir: async () => null,
  };
  return { home, project, projects, options };
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function line(value: object) {
  return JSON.stringify(value) + "\n";
}

describe("externalSessions.list", () => {
  it("keeps live records only and maps status to state", async () => {
    const { home, project, projects, options } = setup([1, 2]);
    record(home, ".claude/sessions", "1.json", { pid: 1, sessionId: "aaaaaaaa-1", cwd: project, startedAt: 5, updatedAt: 10, status: "idle", messagingSocketPath: "/x" });
    record(home, ".claude/sessions", "2.json", { pid: 2, sessionId: "bbbbbbbb-2", cwd: project, updatedAt: 20, status: "busy" });
    record(home, ".claude/sessions", "3.json", { pid: 3, sessionId: "cccccccc-3", cwd: project, updatedAt: 30 });
    write(join(home, ".claude/sessions/bad.json"), "{nope");
    record(home, ".claude/sessions", "4.json", { pid: 1, cwd: project });
    write(join(home, ".claude/sessions/1.key"), "secret");
    const { sessions } = await listExternalSessions(projects, options);
    expect(sessions.map((s) => [s.id, s.state])).toEqual([["bbbbbbbb-2", "running"], ["aaaaaaaa-1", "idle"]]);
    expect(JSON.stringify(sessions)).not.toMatch(/pid|messagingSocketPath/);
    expect(sessions[1]).toMatchObject({ projectId: "p1", source: "claude", startedAt: 5, hasTranscript: false });
  });

  it("drops MonoCode's own sessions", async () => {
    const { home, project, projects, options } = setup([1]);
    record(home, ".claude/sessions", "1.json", { pid: 1, sessionId: "aaaaaaaa-1", cwd: project, updatedAt: 1 });
    expect((await listExternalSessions(projects, { ...options, excludeIds: ["aaaaaaaa-1"] })).sessions).toEqual([]);
  });

  it("skips mirror copies and dedupes by session id", async () => {
    const { home, project, projects, options } = setup([1, 2]);
    record(home, ".claude/sessions", "1.json", { pid: 1, sessionId: "aaaaaaaa-1", cwd: project, updatedAt: 10, name: "old" });
    record(home, ".claude-cx/sessions", "2.json", { pid: 2, sessionId: "aaaaaaaa-1", cwd: project, updatedAt: 20, name: "new" });
    record(home, ".claude-cx/sessions", "copy.json", { pid: 2, sessionId: "dddddddd-1", cwd: project, updatedAt: 30 });
    write(join(home, ".local/state/session-mirror.json"), JSON.stringify({ [join(home, ".claude-cx/sessions/copy.json")]: "/orig" }));
    const { sessions } = await listExternalSessions(projects, options);
    expect(sessions.map((s) => [s.id, s.name, s.source])).toEqual([["aaaaaaaa-1", "new", "claude-cx"]]);
  });

  it("keeps the newest record per pid in agent-sessions", async () => {
    const { home, project, projects, options } = setup([7]);
    record(home, ".codex/agent-sessions", "7.json", { pid: 7, sessionId: "stale-session", cwd: project, updatedAt: 1 });
    record(home, ".codex/agent-sessions", "7-a.json", { pid: 7, sessionId: "older-session", cwd: project, updatedAt: 5 });
    record(home, ".codex/agent-sessions", "7-b.json", { pid: 7, sessionId: "newest-session", cwd: project, updatedAt: 9 });
    const { sessions } = await listExternalSessions(projects, options);
    expect(sessions.map((s) => [s.id, s.source, s.hasTranscript])).toEqual([["newest-session", "codex", false]]);
  });

  it("matches projects by longest prefix, worktrees inside, and git common dir", async () => {
    const { home, project, options } = setup([1, 2, 3, 4, 5]);
    git(project, "init", "-q");
    git(project, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
    const nested = join(project, "packages/app");
    mkdirSync(nested, { recursive: true });
    const elsewhere = join(temp("ext-wt-"), "wt");
    git(project, "worktree", "add", "-q", elsewhere);
    const projects = [{ id: "p1", path: project }, { id: "p2", path: nested }];
    record(home, ".claude/sessions", "1.json", { pid: 1, sessionId: "inside-p1-1", cwd: join(project, ".claude/worktrees/x"), updatedAt: 1 });
    record(home, ".claude/sessions", "2.json", { pid: 2, sessionId: "inside-p2-1", cwd: join(nested, "src"), updatedAt: 2 });
    record(home, ".claude/sessions", "3.json", { pid: 3, sessionId: "worktree-elsewhere", cwd: elsewhere, updatedAt: 3 });
    record(home, ".claude/sessions", "4.json", { pid: 4, sessionId: "sibling-not-1", cwd: project + "-other", updatedAt: 4 });
    record(home, ".claude/sessions", "5.json", { pid: 5, sessionId: "nowhere-at-all", cwd: "/", updatedAt: 5 });
    const { sessions } = await listExternalSessions(projects, { ...options, gitCommonDir: undefined });
    expect(sessions.map((s) => [s.id, s.projectId])).toEqual([
      ["worktree-elsewhere", "p1"],
      ["inside-p1-1", "p1"],
      ["inside-p2-1", "p2"],
    ]);
  });

  it("puts notes on live rows and lists hand-overs and handoff files", async () => {
    const { home, project, projects, options } = setup([1]);
    const common = join(project, ".git");
    options.gitCommonDir = async () => common;
    write(join(project, ".claude/handoff.md"), "# Handoff\nnext steps");
    write(join(project, ".claude/handoff-old.md"), "old");
    utimesSync(join(project, ".claude/handoff-old.md"), new Date(NOW - 8 * 86_400_000), new Date(NOW - 8 * 86_400_000));
    write(join(project, ".claude/handoff-b.md"), "b");
    utimesSync(join(project, ".claude/handoff-b.md"), new Date(NOW - 3_600_000), new Date(NOW - 3_600_000));
    const outside = temp("ext-out-");
    write(join(outside, "h.md"), "x");
    const at = (msAgo: number) => (NOW - msAgo) / 1000;
    const history = [
      { at: at(5000), event: "note", session: "aaaaaaaa-1", text: "first", branch: "old" },
      { at: at(4000), event: "note", session: "aaaaaaaa-1", text: "doing tests", branch: "feat" },
      { at: at(4000), event: "edit", session: "aaaaaaaa-1", text: "ignored" },
      { at: at(3000), event: "note", session: "gone-session-1", name: "g1", worktree: project, branch: "b1", text: "Handed over: .claude/handoff.md." },
      { at: at(2000), event: "note", session: "gone-session-2", worktree: project, text: "handed over: " + join(outside, "h.md") },
      { at: at(1000), event: "note", session: "gone-session-3", worktree: project, text: "handed over: .claude/missing.md" },
      { at: at(8 * 86_400_000), event: "note", session: "gone-session-4", worktree: project, text: "handed over: x" },
      { at: at(500), event: "note", session: "gone-session-5", worktree: project, text: "still working" },
    ];
    write(join(common, "claude-claims-history.jsonl"), "partial}\n" + history.map(line).join(""));
    record(home, ".claude/sessions", "1.json", { pid: 1, sessionId: "aaaaaaaa-1", cwd: project, updatedAt: NOW });
    const { sessions } = await listExternalSessions(projects, options);
    expect(sessions[0]).toMatchObject({ id: "aaaaaaaa-1", note: "doing tests", branch: "feat", state: "running" });
    expect(sessions.slice(1).map((s) => [s.id, s.handoffPath])).toEqual([
      ["gone-session-3", undefined],
      ["gone-session-2", undefined],
      ["gone-session-1", ".claude/handoff.md"],
      ["handoff:.claude/handoff-b.md", ".claude/handoff-b.md"],
    ]);
    expect(sessions[3]).toMatchObject({ name: "g1", branch: "b1", cwd: project, state: "handed-over", source: "claude", updatedAt: NOW - 3000 });
    expect(sessions[4]).toMatchObject({ name: "handoff-b.md", cwd: project, hasTranscript: false, source: "claude" });
  });

  it("caps hand-overs at 20 per project, newest first", async () => {
    const { project, projects, options } = setup();
    const common = join(project, ".git");
    options.gitCommonDir = async () => common;
    const history = Array.from({ length: 25 }, (_, i) => ({ at: (NOW - (i + 1) * 1000) / 1000, event: "note", session: `handed-session-${i}`, worktree: project, text: "handed over" }));
    write(join(common, "claude-claims-history.jsonl"), history.map(line).join(""));
    const { sessions } = await listExternalSessions(projects, options);
    expect(sessions).toHaveLength(20);
    expect(sessions[0].id).toBe("handed-session-0");
    expect(sessions[19].id).toBe("handed-session-19");
  });

  it("finds transcripts and takes the source from the account holding them", async () => {
    const { home, project, projects, options } = setup([1, 2, 3]);
    record(home, ".claude/sessions", "1.json", { pid: 1, sessionId: "aaaaaaaa-1", cwd: project, updatedAt: 3 });
    record(home, ".claude/sessions", "2.json", { pid: 2, sessionId: "bbbbbbbb-2", cwd: project, updatedAt: 2 });
    record(home, ".claude/sessions", "3.json", { pid: 3, sessionId: "cccccccc-3", cwd: project, updatedAt: 1 });
    write(join(home, ".claude/projects", project.replace(/[^A-Za-z0-9]/g, "-"), "aaaaaaaa-1.jsonl"), "");
    write(join(home, ".claude-cx/projects/elsewhere/bbbbbbbb-2.jsonl"), "");
    const { sessions } = await listExternalSessions(projects, options);
    expect(sessions.map((s) => [s.id, s.source, s.hasTranscript])).toEqual([
      ["aaaaaaaa-1", "claude", true],
      ["bbbbbbbb-2", "claude-cx", true],
      ["cccccccc-3", "claude", false],
    ]);
    // On the Mac the second account lives in .claude-exec.
    write(join(home, ".claude-exec/projects/x/cccccccc-3.jsonl"), "");
    const mac = await listExternalSessions(projects, { ...options, platform: "darwin", isAlive: () => true });
    expect(mac.sessions.find((s) => s.id === "cccccccc-3")).toMatchObject({ source: "claude-cx", hasTranscript: true });
  });

  it("checks Mac liveness against the process table", async () => {
    const { home, project, projects, options } = setup();
    const start = new Date(NOW - 3_600_000).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, "$1 $3 $2 $5 $4");
    record(home, ".claude/sessions", "1.json", { pid: 11, sessionId: "aaaaaaaa-1", cwd: project, procStart: start, updatedAt: 1 });
    record(home, ".claude/sessions", "2.json", { pid: 12, sessionId: "bbbbbbbb-2", cwd: project, procStart: start, updatedAt: 2 });
    record(home, ".claude/sessions", "3.json", { pid: 13, sessionId: "cccccccc-3", cwd: project, procStart: start, updatedAt: 3 });
    const table = "   11    01:00:02 /usr/local/bin/claude --resume\n   12    01:00:00 vim\n   13    02:00:00 claude\n";
    const { sessions } = await listExternalSessions(projects, { ...options, platform: "darwin", isAlive: undefined, processTable: async () => table });
    expect(sessions.map((s) => s.id)).toEqual(["aaaaaaaa-1"]);
    expect(etimeSeconds("1-02:03:04")).toBe(93_784);
    expect(macProcStart("Wed Oct 28 08:34:18 2026")).toBe(Date.UTC(2026, 9, 28, 8, 34, 18));
  });

  it("rejects an unknown project", async () => {
    const { projects, options } = setup();
    await expect(listExternalSessions(projects, options, { projectId: "nope" })).rejects.toThrow("not registered");
  });
});

describe("transcript parsing", () => {
  it("reads user, assistant and tool turns and skips the rest", () => {
    const page = { truncated: false };
    const turns = (value: object) => transcriptTurns(JSON.stringify(value), page);
    expect(turns({ type: "user", isSidechain: true, message: { content: "x" } })).toEqual([]);
    expect(turns({ type: "user", isMeta: true, message: { content: "x" } })).toEqual([]);
    expect(transcriptTurns("{bad", page)).toEqual([]);
    expect(turns({ type: "user", message: { content: "<command-name>/clear</command-name>" } })).toEqual([]);
    expect(turns({ type: "user", message: { content: "<system-reminder>hi</system-reminder>  " } })).toEqual([]);
    expect(turns({ type: "user", timestamp: "2026-10-28T00:00:00Z", message: { content: [
      { type: "text", text: "<system-reminder>a\nb</system-reminder>Fix it" },
      { type: "tool_result", content: "no" },
      { type: "image" },
    ] } })).toEqual([{ role: "user", text: "Fix it", at: Date.parse("2026-10-28T00:00:00Z") }]);
    expect(turns({ type: "assistant", message: { content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Sure" },
      { type: "tool_use", name: "Bash", input: { command: "ls -la\nmore" } },
      { type: "tool_use", name: "Read", input: { file_path: "/a/b" } },
      { type: "tool_use", name: "Grep", input: { pattern: "x".repeat(300) } },
      { type: "tool_use", name: "Todo", input: {} },
    ] } }).map((t) => [t.role, t.text])).toEqual([
      ["assistant", "Sure"],
      ["tool", "Bash: ls -la"],
      ["tool", "Read: /a/b"],
      ["tool", "Grep: " + "x".repeat(200)],
      ["tool", "Todo"],
    ]);
    expect(page.truncated).toBe(false);
    const long = turns({ type: "user", message: { content: "y".repeat(5000) } });
    expect(long[0].text).toHaveLength(4000);
    expect(long[0].text.endsWith("…")).toBe(true);
    expect(page.truncated).toBe(true);
  });
});

describe("transcript paging", () => {
  it("pages backward across chunk edges and round-trips the cursor", async () => {
    const dir = temp("ext-tr-");
    const path = join(dir, "t.jsonl");
    // About 1.6 MB of lines of uneven length, so lines straddle chunk edges.
    let text = "";
    for (let i = 0; i < 3000; i++)
      text += line({ type: "user", message: { content: `msg ${i} ${"p".repeat(300 + (i % 400))}` } });
    writeFileSync(path, text);
    expect(text.length).toBeGreaterThan(1024 * 1024);
    const seen: string[] = [];
    let before: number | undefined;
    let pages = 0;
    do {
      const page = await readTranscriptPage(path, before, 200);
      seen.unshift(...page.turns.map((t) => t.text.split(" ").slice(0, 2).join(" ")));
      before = page.before;
      pages += 1;
    } while (before !== undefined && pages < 100);
    expect(seen).toEqual(Array.from({ length: 3000 }, (_, i) => `msg ${i}`));
    const first = await readTranscriptPage(path, undefined, 60);
    expect(first.turns).toHaveLength(60);
    expect(text.slice(first.before! - 1, first.before!)).toBe("\n");
  });

  it("keeps a page under 200 KB", async () => {
    const dir = temp("ext-tr-");
    const path = join(dir, "t.jsonl");
    let text = "";
    for (let i = 0; i < 100; i++) text += line({ type: "user", message: { content: `n${i} ` + "z".repeat(3900) } });
    writeFileSync(path, text);
    const page = await readTranscriptPage(path, undefined, 200);
    expect(page.truncated).toBe(true);
    const size = page.turns.reduce((sum, t) => sum + t.text.length, 0);
    expect(size).toBeLessThanOrEqual(200 * 1024);
    expect(page.turns.at(-1)!.text.startsWith("n99 ")).toBe(true);
    const next = await readTranscriptPage(path, page.before, 200);
    expect(next.turns.at(-1)!.text.startsWith(`n${99 - page.turns.length} `)).toBe(true);
  });
});

describe("externalSessions.read", () => {
  it("returns turns and the handoff, and rejects bad ids", async () => {
    const { home, project, projects, options } = setup([1]);
    const common = join(project, ".git");
    options.gitCommonDir = async () => common;
    record(home, ".claude/sessions", "1.json", { pid: 1, sessionId: "aaaaaaaa-1", cwd: project, updatedAt: 1 });
    write(join(home, ".claude/projects", project.replace(/[^A-Za-z0-9]/g, "-"), "aaaaaaaa-1.jsonl"),
      line({ type: "user", message: { content: "hello" } }) + line({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }));
    write(join(project, ".claude/handoff.md"), "h".repeat(70 * 1024));
    write(join(common, "claude-claims-history.jsonl"), line({ at: (NOW - 1000) / 1000, event: "note", session: "gone-session-1", worktree: project, text: "handed over: .claude/handoff.md" }));
    const read = (params: object) => readExternalSession(projects, options, { projectId: "p1", ...params });
    expect(await read({ sessionId: "aaaaaaaa-1" })).toEqual({ turns: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }] });
    const gone = await read({ sessionId: "gone-session-1" });
    expect(gone.turns).toEqual([]);
    expect(gone.handoff?.path).toBe(".claude/handoff.md");
    expect(gone.handoff?.text).toHaveLength(64 * 1024);
    expect((await read({ sessionId: "gone-session-1", before: 10 })).handoff).toBeUndefined();
    await expect(read({ sessionId: "handoff:../../x" })).rejects.toThrow("Invalid session id");
    await expect(read({ sessionId: "handoff:.claude/../../x.md" })).rejects.toThrow("Invalid session id");
    await expect(read({ sessionId: "short" })).rejects.toThrow("Invalid session id");
    await expect(read({ sessionId: "zzzzzzzz-9" })).rejects.toThrow("Session not found");
    await expect(read({ sessionId: "aaaaaaaa-1", before: -1 })).rejects.toThrow("Invalid before");
    await expect(readExternalSession(projects, options, { projectId: "x", sessionId: "aaaaaaaa-1" })).rejects.toThrow("not registered");
  });

  it("reads a handoff-only row", async () => {
    const { project, projects, options } = setup();
    write(join(project, ".claude/handoff-x.md"), "notes");
    const page = await readExternalSession(projects, options, { projectId: "p1", sessionId: "handoff:.claude/handoff-x.md" });
    expect(page).toEqual({ turns: [], handoff: { path: ".claude/handoff-x.md", text: "notes" } });
  });
});
