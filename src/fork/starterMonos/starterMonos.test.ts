// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentApp, type AgentAppHost } from "../../features/agent-app/model/agentApp";
import { newSession, type Session } from "../../features/sessions/model/session";
import { findMono, listMonos, MONO_COLORS, monoForSession, removeMono, saveMonoSessionId } from "../../features/monos/model/mono";
import type { Habit } from "../../features/monos/model/monoHabits";
import { loadRecents, rememberProject } from "../../features/projects/model/recents";
import { PROJECT_MASCOTS } from "../../features/projects/model/projectMascots";
import { ensureStarterMono, seedStarterMonos, starterMonoId } from "./starterMono";
import { KICKOFF_MONO } from "./kickoffMono";
import { MONO_MAKER } from "./makerMono";
import { DOJO_MONO } from "./dojoMono"; // Fork
import { SWEEP_MONO } from "./sweepMono";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const APP = "/Users/sam/projects/app";
const SITE = "/Users/sam/projects/site";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:tab-group:key-version", "2");
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
  // happy-dom has no Web Locks; the app's WebKit does.
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: (_name: string, work: () => unknown) => Promise.resolve(work()) },
  });
});

/** A host whose Mono chats are the sessions saved on each Mono. */
function monoHost(files: Map<string, string> = new Map()) {
  const habits = new Map<string, Habit[]>();
  const added: string[] = [];
  const host = {
    isMono: (id: string) => !!monoForSession(id),
    monoOf: (id: string) => {
      const mono = monoForSession(id);
      return mono && { id: mono.id, projects: mono.projects };
    },
    monos: { enabled: () => true, prepare: vi.fn(async () => {}) },
    habits: {
      load: async (id: string) => habits.get(id) ?? [],
      update: async <T,>(id: string, change: (list: Habit[]) => { habits: Habit[]; result: T }) => {
        const next = change(habits.get(id) ?? []);
        habits.set(id, next.habits);
        return next.result;
      },
    },
    readAgentFile: async (id: string) => {
      const text = files.get(id) ?? findMono(id)?.instructions ?? null;
      return { text, hash: `h:${text?.length ?? 0}` };
    },
    writeAgentFile: async (id: string, _path: string, text: string) => {
      files.set(id, text);
      return `h:${text.length}`;
    },
    addProject: (path: string) => {
      added.push(path);
      rememberProject(path);
    },
  } as unknown as AgentAppHost;
  return { host, habits, added };
}

function chatOf(monoId: string, mode: Session["runtimeMode"] = "full-access"): Session {
  const session = newSession("claude", "/Users/sam", undefined, mode);
  saveMonoSessionId(monoId, session.id);
  return session;
}

describe("starter Monos", () => {
  it("are made once each, with their look and instructions, and no projects", async () => {
    await seedStarterMonos([KICKOFF_MONO, MONO_MAKER, SWEEP_MONO, DOJO_MONO]);
    await seedStarterMonos([KICKOFF_MONO, MONO_MAKER, SWEEP_MONO, DOJO_MONO]);
    expect(listMonos()).toHaveLength(4);
    const kickoff = findMono(starterMonoId(KICKOFF_MONO)!)!;
    expect(kickoff).toMatchObject({ name: "Kickoff", mascot: "rocket", projects: [] });
    expect(kickoff.instructions).toMatch(/You are Kickoff/);
    expect(findMono(starterMonoId(MONO_MAKER)!)).toMatchObject({ name: "Maker", mascot: "anvil" });
    const sweep = findMono(starterMonoId(SWEEP_MONO)!)!;
    expect(sweep).toMatchObject({ name: "Sweep", mascot: "broom", projects: [] });
    expect(sweep.instructions).toMatch(/You are Sweep/);
    const dojo = findMono(starterMonoId(DOJO_MONO)!)!;
    expect(dojo).toMatchObject({ name: "Dojo", mascot: "belt", projects: [] });
    expect(dojo.instructions).toMatch(/You are Dojo/);
    expect(PROJECT_MASCOTS.map((mascot) => mascot.name)).toEqual(expect.arrayContaining(["rocket", "anvil", "broom", "belt"]));
  });

  it("stays deleted once the user deletes it", () => {
    const dojoId = ensureStarterMono(DOJO_MONO)!; // Fork: Dojo stays deleted too.
    removeMono(dojoId);
    expect(ensureStarterMono(DOJO_MONO)).toBeUndefined();
    const id = ensureStarterMono(KICKOFF_MONO)!;
    removeMono(id);
    expect(ensureStarterMono(KICKOFF_MONO)).toBeUndefined();
    expect(starterMonoId(KICKOFF_MONO)).toBeUndefined();
    expect(listMonos()).toHaveLength(0);
  });
});

describe("projects.create", () => {
  it("makes a new folder, puts it on the rail and gives it to the Mono", async () => {
    const id = ensureStarterMono(KICKOFF_MONO)!;
    const chat = chatOf(id);
    const { host, added } = monoHost();
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) =>
      command === "create_path" ? `/Users/sam/Documents/projects/${args.name}` : undefined);
    const result = await handleAgentApp(chat, "c1", "projects.create", { name: "jobbird" }, host) as { project: string };
    const path = "/Users/sam/Documents/projects/jobbird";
    expect(mocks.invoke).toHaveBeenCalledWith("create_path", { parent: "~/Documents/projects", name: "jobbird", isDir: true });
    expect(result.project).toBe(path);
    expect(added).toEqual([path]);
    expect(loadRecents()[0].path).toBe(path);
    expect(findMono(id)!.projects).toEqual([path]);
  });

  it("refuses bad names and parents, and non-Mono sessions", async () => {
    const id = ensureStarterMono(KICKOFF_MONO)!;
    const chat = chatOf(id);
    const { host } = monoHost();
    const create = (input: Record<string, unknown>, source = chat) =>
      handleAgentApp(source, `c-${JSON.stringify(input)}`, "projects.create", input, host);
    await expect(create({ name: "../x" })).rejects.toThrow(/folder name/);
    await expect(create({ name: "a b" })).rejects.toThrow(/folder name/);
    await expect(create({ name: "ok", parent: "relative/dir" })).rejects.toThrow(/parent/);
    await expect(create({ name: "ok", parent: "/Users/sam/../etc" })).rejects.toThrow(/\.\./);
    await expect(create({ name: "ok", parent: "~/projects\\..\\..\\etc" })).rejects.toThrow(/\.\./);
    await expect(create({ name: "ok" }, newSession("claude", APP))).rejects.toThrow(/Mono's own chat/);
    expect(mocks.invoke).not.toHaveBeenCalledWith("create_path", expect.anything());
  });
});

describe("Mono Maker actions", () => {
  it("are only for the Mono Maker's chat", async () => {
    const kickoff = ensureStarterMono(KICKOFF_MONO)!;
    ensureStarterMono(MONO_MAKER);
    const { host } = monoHost();
    await expect(handleAgentApp(chatOf(kickoff), "a", "monos.all", {}, host)).rejects.toThrow(/Mono Maker/);
    await expect(handleAgentApp(newSession("claude", APP), "b", "monos.make", { name: "X" }, host)).rejects.toThrow(/Mono Maker/);
  });

  it("lists every Mono and makes a new one with look, projects, soul and a paused habit", async () => {
    rememberProject(SITE);
    rememberProject(APP);
    const maker = ensureStarterMono(MONO_MAKER)!;
    const chat = chatOf(maker);
    const { host, habits } = monoHost();

    const all = await handleAgentApp(chat, "l", "monos.all", {}, host) as {
      monos: { name: string }[]; choices: { projects: { path: string }[]; colors: unknown[] };
    };
    expect(all.monos.map((mono) => mono.name)).toEqual(["Maker"]);
    expect(all.choices.projects.map((project) => project.path)).toEqual([APP, SITE]);
    expect(all.choices.colors).toHaveLength(MONO_COLORS.length);

    const made = await handleAgentApp(chat, "m", "monos.make", {
      name: "Releases",
      mascot: "owl",
      color: 3,
      projects: ["app", SITE],
      instructions: "You are Releases.",
      habit: { name: "Weekly notes", instructions: "Draft release notes.", schedule: { kind: "weekly", dayOfWeek: 5, time: "16:00" } },
    }, host) as { mono: { id: string; instructions: string; habits: { enabled: boolean }[] }; created: boolean };
    expect(made.created).toBe(true);
    expect(findMono(made.mono.id)).toMatchObject({ name: "Releases", mascot: "owl", color: MONO_COLORS[3], projects: [APP, SITE] });
    expect(made.mono.instructions).toBe("You are Releases.");
    expect(habits.get(made.mono.id)).toHaveLength(1);
    expect(made.mono.habits[0].enabled).toBe(false);
    expect(host.monos!.prepare).toHaveBeenCalledWith(made.mono.id);

    // Changing it: omitted fields stay; a SOUL.md that exists needs its hash.
    await expect(handleAgentApp(chat, "u1", "monos.make", { id: made.mono.id, instructions: "New." }, host))
      .rejects.toThrow(/expectedSoulHash/);
    const detail = await handleAgentApp(chat, "d", "monos.all", { id: made.mono.id }, host) as { soulHash: string };
    await handleAgentApp(chat, "u2", "monos.make", {
      id: made.mono.id, color: "#AA3366", instructions: "New.", expectedSoulHash: detail.soulHash,
    }, host);
    expect(findMono(made.mono.id)).toMatchObject({ name: "Releases", color: "#aa3366", projects: [APP, SITE] });

    // A stale hash changes nothing, not even the look.
    await expect(handleAgentApp(chat, "u3", "monos.make", {
      id: made.mono.id, color: 1, instructions: "Newer.", expectedSoulHash: "stale",
    }, host)).rejects.toThrow(/expectedSoulHash/);
    expect(findMono(made.mono.id)!.color).toBe("#aa3366");

    // A later step failing puts the old look back.
    vi.mocked(host.monos!.prepare).mockRejectedValueOnce(new Error("offline"));
    await expect(handleAgentApp(chat, "u4", "monos.make", { id: made.mono.id, name: "Ship", projects: [] }, host))
      .rejects.toThrow(/offline/);
    expect(findMono(made.mono.id)).toMatchObject({ name: "Releases", projects: [APP, SITE] });
  });

  it("takes back a new Mono it could not finish setting up", async () => {
    const maker = ensureStarterMono(MONO_MAKER)!;
    const chat = chatOf(maker);
    const { host } = monoHost();
    vi.mocked(host.monos!.prepare).mockRejectedValueOnce(new Error("offline"));
    await expect(handleAgentApp(chat, "f", "monos.make", { name: "Flaky" }, host)).rejects.toThrow(/offline/);
    expect(listMonos().map((mono) => mono.name)).toEqual(["Maker"]);
    const retry = await handleAgentApp(chat, "f2", "monos.make", { name: "Flaky" }, host) as { created: boolean };
    expect(retry.created).toBe(true);
  });

  it("checks the whole change before making anything", async () => {
    rememberProject(APP);
    const maker = ensureStarterMono(MONO_MAKER)!;
    const chat = chatOf(maker);
    const { host } = monoHost();
    const make = (input: Record<string, unknown>, source = chat) =>
      handleAgentApp(source, `m-${JSON.stringify(input)}`, "monos.make", input, host);
    await expect(make({ mascot: "owl" })).rejects.toThrow(/needs a name/);
    await expect(make({ name: "Maker" })).rejects.toThrow(/already has that name/);
    await expect(make({ name: "X", mascot: "dragon" })).rejects.toThrow(/mascot/);
    await expect(make({ name: "X", color: "red" })).rejects.toThrow(/color/);
    await expect(make({ name: "X", projects: ["nowhere"] })).rejects.toThrow(/not one project/);
    await expect(make({ name: "X", habit: { name: "h" } })).rejects.toThrow(/habit requires/);
    await expect(make({ id: maker, name: "Y" })).rejects.toThrow(/soul.update/);
    await expect(make({ name: "X", instructions: "Hi" }, chatOf(maker, "auto-edit" as Session["runtimeMode"])))
      .rejects.toThrow(/Full access/);
    expect(listMonos()).toHaveLength(1);
  });
});
