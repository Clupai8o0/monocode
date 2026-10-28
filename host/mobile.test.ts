import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { HostEngine } from "./engine";
import { HostStore } from "./store";
import { createHostServer } from "./server";
import { HostChildBackend } from "./child-backend";
import { configureChildBackend } from "../src/integrations/harness/core/child";
import type { SendTurnInput } from "../src/integrations/harness/core/types";

vi.mock("../src/integrations/harness/providers/codex/codexCatalog", () => ({
  discoverCodexModels: vi.fn(),
}));
// This machine's real sign-ins stay out of the tests.
vi.mock("./accounts", () => {
  const accounts = [
    { id: "default", provider: "codex", label: "Default account", dir: "/c", isDefault: true },
    { id: "work", provider: "codex", label: "work@example.com (work)", dir: "/w", isDefault: false },
    { id: "default", provider: "claude", label: "Default account", dir: "/a", isDefault: true },
  ];
  return {
    hostAccounts: () => accounts,
    hostAccount: (provider: unknown, id: unknown) =>
      accounts.find(
        (account) =>
          account.provider === provider && account.id === (id || "default"),
      ),
  };
});
configureChildBackend(new HostChildBackend({}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "monocode-mobile-test-"));
  const store = new HostStore(join(directory, "host.db"));
  const turns: Array<{ input: SendTurnInput; finish: () => void }> = [];
  const approve = vi.fn();
  const engine = new HostEngine(store, {
    codex: {
      send: (input) =>
        new Promise<void>((resolve) => {
          turns.push({ input, finish: resolve });
        }),
      stop: async () => turns.at(-1)?.finish(),
      cancel: async () => turns.at(-1)?.finish(),
      bind: () => {},
      approve,
      answer: () => {},
    },
  });
  const project = await engine.openProject(directory);
  const server = createHostServer(engine, ["codex"]);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mobile`;
  const device = store.issueDevice("Phone");
  let next = 0;
  const call = async (
    method: string,
    params: object = {},
    headers: Record<string, string> = { Authorization: `Bearer ${device.token}` },
    /** The command id; given, a retry of the same request can be sent. */
    id = `c${next++}`,
  ) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: 1, id, method, params }),
    });
    const body = response.ok ? await response.json() : null;
    return { status: response.status, ...(body as { ok?: boolean; result?: any; error?: string }) };
  };
  cleanups.push(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { call, project, turns, approve, device, store };
}

describe("phone endpoint", () => {
  it("answers the external sessions methods", async () => {
    const { call, project } = await setup();
    const listed = await call("externalSessions.list", { projectId: project.id });
    expect(listed.result).toEqual({ sessions: [] });
    const read = await call("externalSessions.read", { projectId: project.id, sessionId: "zzzzzzzz-9" });
    expect(read.ok).toBe(false);
    expect(read.error).toBe("Session not found");
  });

  it("refuses calls without the device credential or from a browser", async () => {
    const { call, device } = await setup();
    expect((await call("workspace.list", {}, {})).status).not.toBe(200);
    expect(
      (await call("workspace.list", {}, { Authorization: "Bearer nope" })).status,
    ).not.toBe(200);
    expect(
      (
        await call("workspace.list", {}, {
          Authorization: `Bearer ${device.token}`,
          Origin: "https://example.com",
        })
      ).status,
    ).not.toBe(200);
  });

  it("starts a session, shows its approval, and passes the decision on", async () => {
    const { call, project, turns, approve } = await setup();
    const listed = await call("workspace.list");
    expect(listed.ok).toBe(true);
    expect(listed.result.projects.map((item: { id: string }) => item.id)).toEqual([
      project.id,
    ]);
    const started = await call("session.start", {
      projectId: project.id,
      text: "Fix the build\nthen test",
      model: "codex:test",
    });
    expect(started.error).toBeUndefined();
    const sessionId = started.result.sessionId as string;
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    turns[0].input.onEvent({
      type: "approval.requested",
      requestId: 7,
      title: "Run a command?",
    });
    await vi.waitFor(async () => {
      const session = (await call("workspace.list")).result.sessions.find(
        (item: { id: string }) => item.id === sessionId,
      );
      expect(session).toMatchObject({
        title: "Fix the build",
        busy: true,
        waiting: "approval",
        approval: { requestId: 7 },
      });
    });
    const decided = await call("session.approve", {
      conversationId: sessionId,
      requestId: 7,
      decision: "allow",
    });
    expect(decided.ok).toBe(true);
    expect(approve).toHaveBeenCalledWith(sessionId, 7, "allow");

    const watch = await call("conversation.watch", { conversationId: sessionId });
    turns[0].finish();
    await vi.waitFor(async () => {
      const frames = await call("watch.next", {
        watchId: watch.result.watchId,
        timeoutMs: 500,
      });
      expect(frames.ok).toBe(true);
      expect(frames.result.updates.at(-1)?.busy).toBe(false);
    });
    expect((await call("watch.close", { watchId: watch.result.watchId })).ok).toBe(true);
  });

  it("lists the host's account and refuses usage for providers without it", async () => {
    const { discoverCodexModels } = await import(
      "../src/integrations/harness/providers/codex/codexCatalog"
    );
    vi.mocked(discoverCodexModels).mockResolvedValue([
      { id: "gpt-6.1", name: "GPT-6.1" } as never,
    ]);
    const { call, project } = await setup();
    const catalog = await call("models.list", { projectId: project.id });
    expect(catalog.result.accounts).toEqual([
      { id: "default", provider: "codex", label: "Default account", isDefault: true },
      { id: "work", provider: "codex", label: "work@example.com (work)", isDefault: false },
    ]);
    const usage = await call("accounts.usage", { provider: "opencode" });
    expect(usage.ok).toBe(false);
    expect(usage.error).toMatch(/only available/);
  });

  it.runIf(process.platform === "linux")(
    "opens a shell in the project and refuses a closed one",
    async () => {
      const { call, project } = await setup();
      const opened = await call("terminal.open", { projectId: project.id });
      expect(opened.ok).toBe(true);
      const { terminalId } = opened.result;
      expect((await call("terminal.write", { terminalId, data: "pwd\r" })).ok).toBe(true);
      let output = "";
      let cursor = 0;
      for (let i = 0; i < 20 && !output.includes(project.cwd); i++) {
        const read = await call("terminal.read", { terminalId, cursor, timeoutMs: 500 });
        output += read.result.output;
        cursor = read.result.cursor;
      }
      expect(output).toContain(project.cwd);
      expect((await call("terminal.close", { terminalId })).ok).toBe(true);
      const closed = await call("terminal.read", { terminalId, cursor });
      expect(closed.error).toMatch(/closed/);
    },
    20_000,
  );

  it("starts a session with the account the phone picked, and refuses an unknown one", async () => {
    const { call, project, turns } = await setup();
    const refused = await call("session.start", {
      projectId: project.id,
      harness: "codex",
      model: "gpt-6.1",
      text: "hi",
      providerAccountId: "gone",
    });
    expect(refused.error).toMatch(/no longer available/);
    const started = await call("session.start", {
      projectId: project.id,
      harness: "codex",
      model: "gpt-6.1",
      text: "hi",
      providerAccountId: "work",
    });
    expect(started.ok).toBe(true);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.input.providerAccountId).toBe("work");
    const catalog = await call("models.list", {
      conversationId: started.result.sessionId,
    });
    expect(catalog.result.current.providerAccountId).toBe("work");
    turns[0]!.finish();
  });

  it("lists a Mono, and talks to it in its own conversation with its soul handed over", async () => {
    const { call, store, turns, project } = await setup();
    const { discoverCodexModels } = await import(
      "../src/integrations/harness/providers/codex/codexCatalog"
    );
    vi.mocked(discoverCodexModels).mockResolvedValue([
      { id: "gpt-6.1", name: "GPT-6.1" } as never,
    ]);
    const monoDir = join(store.attachmentDir, "..", "monos");
    mkdirSync(join(monoDir, "m1"), { recursive: true });
    writeFileSync(join(monoDir, "m1", "SOUL.md"), "Answer in haiku.");
    writeFileSync(
      join(monoDir, "roster.json"),
      JSON.stringify([
        { id: "m1", name: "Poet", mascot: "ghost", color: "#fff", projects: [project.cwd] },
      ]),
    );
    const listed = (await call("workspace.list")).result;
    expect(listed.monos).toEqual([
      expect.objectContaining({ id: "m1", name: "Poet", projectIds: [project.id], status: "idle" }),
    ]);

    const sent = await call("conversation.send", { conversationId: "mono:m1", text: "Hello" });
    expect(sent.ok).toBe(true);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.input.text).toContain("Answer in haiku.");
    expect(turns[0]!.input.text).toMatch(/Hello$/);
    expect(turns[0]!.input.cwd).toContain(join("monos", "m1"));
    // The transcript keeps what the user wrote, and the Mono keeps its session.
    const read = await call("conversation.read", { conversationId: "mono:m1" });
    expect(read.result.messages).toEqual([
      expect.objectContaining({ role: "user", text: "Hello" }),
    ]);
    expect(read.result.id).toBe(sent.result.sessionId);
    turns[0]!.finish();
    const again = (await call("workspace.list")).result;
    // Its folder is not a project, and its conversation is not a project session.
    expect(again.projects.map((entry: { id: string }) => entry.id)).toEqual([project.id]);
    expect(again.sessions).toEqual([]);
    expect(again.monos[0].sessionId).toBe(sent.result.sessionId);
    // A message starting with a path is not a command: it still gets the soul.
    await call("conversation.send", { conversationId: "mono:m1", text: "/tmp/x: look" });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.input.text).toContain("Answer in haiku.");
    turns[1]!.finish();
  });

  it("shows projects with the desktop's names, colours, mascots and order", async () => {
    const { call, store, project } = await setup();
    const other = mkdtempSync(join(tmpdir(), "monocode-mobile-test-other-"));
    cleanups.push(async () => rmSync(other, { recursive: true, force: true }));
    const second = store.addProject(other, "zzz");
    writeFileSync(
      join(store.attachmentDir, "..", "desktop.json"),
      JSON.stringify({
        order: [second.cwd, project.cwd],
        projects: { [second.cwd]: { name: "First", color: "#123456", mascot: "bird" } },
        defaultModels: {},
      }),
    );
    const listed = (await call("workspace.list")).result.projects;
    expect(listed.map((entry: { name: string }) => entry.name)).toEqual([
      "First",
      project.name,
    ]);
    expect(listed[0]).toMatchObject({ color: "#123456", mascot: "bird" });
    expect(listed[1].mascot).toBeUndefined();
  });

  it("answers a catalog the phone already has with a short reply", async () => {
    const { call, project } = await setup();
    const first = (await call("workspace.list")).result;
    expect(first.projects[0].id).toBe(project.id);
    expect(first.etag).toEqual(expect.any(String));
    expect((await call("workspace.list", { since: first.etag })).result).toEqual({
      unchanged: true,
      etag: first.etag,
    });
    await call("session.start", { projectId: project.id, text: "Hi", model: "codex:test" });
    const changed = (await call("workspace.list", { since: first.etag })).result;
    expect(changed.sessions).toHaveLength(1);
    expect(changed.etag).not.toBe(first.etag);
  });

  it("counts a project's changed lines once opened, and changes the etag", async () => {
    const { call, store } = await setup();
    const repo = mkdtempSync(join(tmpdir(), "monocode-mobile-test-repo-"));
    cleanups.push(async () => rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: repo,
      });
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git("add", ".");
    git("commit", "-qm", "first");
    writeFileSync(join(repo, "a.txt"), "one\nthree\nfour\n");
    writeFileSync(join(repo, "new.txt"), "x\ny\n");
    const added = store.addProject(repo, "repo");
    const first = (await call("workspace.list")).result;
    expect(first.projects.find((p: { id: string }) => p.id === added.id)).toMatchObject({
      additions: 0,
      deletions: 0,
    });
    await call("project.files", { projectId: added.id });
    let listed = first;
    for (let tries = 0; tries < 100; tries++) {
      listed = (await call("workspace.list", { since: first.etag })).result;
      if (!listed.unchanged) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(listed.etag).not.toBe(first.etag);
    expect(listed.projects.find((p: { id: string }) => p.id === added.id)).toMatchObject({
      additions: 4,
      deletions: 1,
    });
  });

  it("gives a device this host's notification server and topic, once set up", async () => {
    const { call, store } = await setup();
    expect((await call("notify.config")).result).toEqual({ config: null });
    writeFileSync(
      join(store.attachmentDir, "..", "notify.json"),
      JSON.stringify({ server: "https://ntfy.example:8443/", topic: "monocode-abc" }),
    );
    expect((await call("notify.config")).result).toEqual({
      config: { server: "https://ntfy.example:8443", topic: "monocode-abc" },
    });
    expect(
      (await call("notify.config", {}, { Authorization: "Bearer nope" })).status,
    ).not.toBe(200);
  });

  it("answers unknown methods and missing sessions as failures, not crashes", async () => {
    const { call } = await setup();
    expect(await call("files.read")).toMatchObject({ status: 200, ok: false });
    expect(
      await call("conversation.send", { conversationId: "missing", text: "hi" }),
    ).toMatchObject({ status: 200, ok: false });
  });
});

describe("phone files and changes", () => {
  it("lists a folder, reads a file, and finds one by name", async () => {
    const { call, project } = await setup();
    const root = project.cwd;
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "export const x = 1;\n");
    writeFileSync(join(root, "README.md"), "# Hello\n");

    const top = await call("project.files", { projectId: project.id, path: "" });
    expect(top.ok).toBe(true);
    // The host's own database sits in this test's project folder too.
    const names = top.result.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
    expect(top.result.entries.find((entry: { name: string }) => entry.name === "src"))
      .toMatchObject({ isDir: true });

    const read = await call("project.file", {
      projectId: project.id,
      path: "src/app.ts",
    });
    expect(read.result).toMatchObject({
      path: "src/app.ts",
      text: "export const x = 1;\n",
      truncated: false,
    });

    // A transcript names a file short, with a line, or by its full path on the
    // host; each still opens.
    for (const asked of [
      "app.ts:12",
      "src/app.ts:12:3",
      "./src/app.ts",
      join(root, "src", "app.ts"),
    ]) {
      const opened = await call("project.file", {
        projectId: project.id,
        path: asked,
      });
      expect(opened.result?.path, asked).toBe("src/app.ts");
    }

    const found = await call("project.search", {
      projectId: project.id,
      query: "app",
    });
    expect(found.result.results).toEqual([{ path: "src/app.ts", name: "app.ts" }]);
    expect((await call("project.search", { projectId: project.id, query: " " })).result)
      .toEqual({ results: [] });
  });

  it("reports the branch, the changes with their diffs, and stages them", async () => {
    const { call, project } = await setup();
    const root = project.cwd;
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-qm", "first");
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");

    const changed = await call("project.changes", { projectId: project.id });
    expect(changed.ok).toBe(true);
    expect(changed.result.branch).toBe("main");
    const [file] = changed.result.files;
    expect(file).toMatchObject({ relative: "a.txt", status: "modified", staged: false });
    expect(file.lines.some((line: { kind: string }) => line.kind === "add")).toBe(true);

    const status = await call("project.git", { projectId: project.id });
    expect(status.result).toMatchObject({
      branch: "main",
      remote: false,
      upstream: false,
      canGenerate: false,
      pr: null,
    });
    expect(status.result.files).toBeGreaterThanOrEqual(1);

    const staged = await call("project.gitAction", {
      projectId: project.id,
      action: "stage",
      paths: ["a.txt"],
    });
    expect(staged.ok).toBe(true);
    await vi.waitFor(async () => {
      const again = await call("project.changes", { projectId: project.id });
      expect(again.result.files[0].staged).toBe(true);
    });

    // Writing the message needs an agent, which the host has no equivalent of.
    expect(
      await call("project.gitAction", { projectId: project.id, action: "generate" }),
    ).toMatchObject({ ok: false });
  });

  it("previews a file past the size limit instead of refusing it", async () => {
    const { call, project } = await setup();
    // A megabyte and a bit of text: over the slice the phone is sent.
    writeFileSync(join(project.cwd, "big.txt"), "x".repeat(1024 * 1024 + 10));
    const read = await call("project.file", {
      projectId: project.id,
      path: "big.txt",
    });
    expect(read.ok).toBe(true);
    expect(read.result.truncated).toBe(true);
    expect(read.result.text).toHaveLength(1024 * 1024);
  });

  it("cuts a multi-byte file on a character, not mid-sequence", async () => {
    const { call, project } = await setup();
    // Over the character limit, and two bytes per character, so a byte-wise
    // cut would land inside one.
    writeFileSync(join(project.cwd, "accents.txt"), "é".repeat(1024 * 1024 + 10));
    const read = await call("project.file", {
      projectId: project.id,
      path: "accents.txt",
    });
    expect(read.result.truncated).toBe(true);
    expect(read.result.text).toHaveLength(1024 * 1024);
    expect(read.result.text).not.toContain("\uFFFD");
    expect(read.result.text.at(-1)).toBe("é");
  });

  it("refuses a binary file", async () => {
    const { call, project } = await setup();
    writeFileSync(join(project.cwd, "blob.bin"), Buffer.from([1, 0, 2]));
    expect(
      await call("project.file", { projectId: project.id, path: "blob.bin" }),
    ).toMatchObject({ ok: false });
  });

  it("lists no worktrees for a plain checkout, and refuses an unknown one", async () => {
    const { call, project } = await setup();
    execFileSync("git", ["init", "-q"], { cwd: project.cwd });
    expect((await call("project.worktrees", { projectId: project.id })).result)
      .toEqual({ worktrees: [] });
    expect(
      await call("project.changes", {
        projectId: project.id,
        worktreePath: "/tmp/not-a-worktree",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("phone retries", () => {
  it("starts one session for a command id asked twice", async () => {
    const { call, project } = await setup();
    const params = { projectId: project.id, text: "Hello", model: "codex:test" };
    const first = await call("session.start", params, undefined, "retry");
    const again = await call("session.start", params, undefined, "retry");
    expect(first.ok).toBe(true);
    expect(again.result.sessionId).toBe(first.result.sessionId);
    expect((await call("workspace.list")).result.sessions).toHaveLength(1);
  });
});

describe("phone attachments", () => {
  it("stages a photo sent inline and passes it to the turn", async () => {
    const { call, project, turns } = await setup();
    const data = Buffer.from("not really a png").toString("base64");
    const started = await call("session.start", {
      projectId: project.id,
      text: "What is this?",
      model: "codex:test",
      attachments: [{ name: "shot.png", mimeType: "image/png", data }],
    });
    expect(started.error).toBeUndefined();
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const [file] = turns[0].input.attachments ?? [];
    expect(file).toMatchObject({
      name: "shot.png",
      mimeType: "image/png",
      kind: "image",
      size: 16,
    });
    expect(readFileSync(file.path!, "utf8")).toBe("not really a png");
  });

  it("stages one copy of an attachment for a command id asked twice", async () => {
    const { call, project, turns } = await setup();
    const data = Buffer.from("once only").toString("base64");
    const params = {
      projectId: project.id,
      text: "Look",
      model: "codex:test",
      attachments: [{ name: "a.png", mimeType: "image/png", data }],
    };
    const first = await call("session.start", params, undefined, "same");
    const again = await call("session.start", params, undefined, "same");
    expect(again.result.sessionId).toBe(first.result.sessionId);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0].input.attachments).toHaveLength(1);
  });

  it("leaves no files behind when the send is refused", async () => {
    const { call, project, store } = await setup();
    const data = Buffer.from("orphan").toString("base64");
    // No such session, so the turn is never accepted.
    expect(
      await call("conversation.send", {
        conversationId: "missing",
        text: "hi",
        attachments: [{ name: "a.png", mimeType: "image/png", data }],
      }),
    ).toMatchObject({ ok: false });
    expect(existsSync(store.attachmentDir) ? readdirSync(store.attachmentDir) : [])
      .toEqual([]);
    void project;
  });

  it("takes attachments with no message, and refuses an oversized set", async () => {
    const { call, project, turns } = await setup();
    const data = Buffer.from("x").toString("base64");
    expect(
      (
        await call("session.start", {
          projectId: project.id,
          text: "",
          model: "codex:test",
          attachments: [{ name: "a.png", mimeType: "image/png", data }],
        })
      ).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(turns).toHaveLength(1));

    const huge = "A".repeat(13 * 1024 * 1024);
    expect(
      await call("conversation.send", {
        conversationId: turns[0].input.sessionId,
        text: "hi",
        attachments: [{ name: "big.bin", mimeType: "application/octet-stream", data: huge }],
      }),
    ).toMatchObject({ ok: false });
  });
});
