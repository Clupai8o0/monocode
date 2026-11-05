// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentApp, type AgentAppHost } from "../../features/agent-app/model/agentApp";
import { newSession } from "../../features/sessions/model/session";
import { resetHarnessModelOverlays, setHarnessModels } from "../../features/sessions/model/models";
import { setHarnessAvailability, type HarnessAvailability } from "../../integrations/harness/core/availabilityState";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  saveTabGroupMascot,
} from "../../features/workspace/model/tabGroups";
import { findMono, listMonos, removeMono, removeMonoProject } from "../../features/monos/model/mono";
import { PROJECT_MASCOTS } from "../../features/projects/model/projectMascots";
import type { ProjectLook } from "./agentProjectLook";
import {
  ensureStylistMono,
  seedStylistMono,
  STYLIST_COLOR,
  STYLIST_MASCOT,
  STYLIST_NAME,
  STYLIST_SOUL,
  withoutOldStylistLines,
} from "./stylistMono";
import { monoContext } from "../../features/monos/model/monoFiles";

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
});

describe("project look app actions", () => {
  const source = newSession("claude", APP);
  const host = { isMono: () => false } as unknown as AgentAppHost;
  const look = (input: Record<string, unknown> = {}) =>
    handleAgentApp(source, "look", "projects.look", input, host) as Promise<ProjectLook>;
  const set = (input: Record<string, unknown>) =>
    handleAgentApp(source, "set", "projects.look.set", input, host) as Promise<ProjectLook>;

  it("reads the default look with the choices to pick from", async () => {
    const result = await look();
    expect(result).toMatchObject({
      project: APP,
      name: "app",
      label: null,
      logo: null,
      background: "transparent",
      iconsDir: null,
      color: { palette: null, custom: null },
      mascot: { saved: null },
    });
    expect(result.choices.mascots).toContain(STYLIST_MASCOT);
    expect(result.choices.mascots).toHaveLength(PROJECT_MASCOTS.length);
    expect(result.choices.mascots).toContain("flower");
    expect(result.choices.mascots).toContain("pig");
    expect(result.choices.mascots).toContain("couple");
    expect(result.choices.colors[0]).toEqual({ index: 0, value: expect.any(String) });
  });

  it("saves label, color and mascot the way the project menu does", async () => {
    const result = await set({ label: " App ", color: "#4F7CFF", mascot: "beret" });
    expect(loadTabGroupLabels()[APP]).toBe("App");
    expect(loadTabGroupCustomColors()[APP]).toBe("#4f7cff");
    expect(loadTabGroupMascots()[APP]).toBe("beret");
    expect(result).toMatchObject({
      label: "App",
      color: { value: "#4f7cff", custom: "#4f7cff", palette: null },
      mascot: { name: "beret", saved: "beret" },
    });

    const indexed = await set({ color: 3 });
    expect(loadTabGroupColors()[APP]).toBe(3);
    expect(loadTabGroupCustomColors()[APP]).toBeUndefined();
    expect(indexed.color.palette).toBe(3);

    const reset = await set({ label: null, color: null, mascot: null });
    expect(reset).toMatchObject({ label: null, color: { palette: null, custom: null }, mascot: { saved: null } });
  });

  it("checks every field before changing any", async () => {
    await expect(set({ label: "Fine", mascot: "not-a-mascot" })).rejects.toThrow(/mascot/);
    await expect(set({ color: "blue" })).rejects.toThrow(/color/);
    await expect(set({ color: 99 })).rejects.toThrow(/color/);
    await expect(set({ label: "x".repeat(41) })).rejects.toThrow(/label/);
    await expect(set({})).rejects.toThrow(/at least one/);
    await expect(set({ tagline: "no" })).rejects.toThrow(/Unknown/);
    expect(loadTabGroupLabels()[APP]).toBeUndefined();
  });
});

describe("Stylist Mono", () => {
  it("is made once, with its look, its instructions and every local project", () => {
    const id = ensureStylistMono([APP, SITE, "remote://box/repo"]);
    expect(id).toBeDefined();
    const mono = findMono(id!)!;
    expect(mono).toMatchObject({
      name: STYLIST_NAME,
      mascot: STYLIST_MASCOT,
      color: STYLIST_COLOR,
      projects: [APP, SITE],
    });
    expect(mono.instructions).toMatch(/You are the Stylist/);
    expect(ensureStylistMono([APP, SITE])).toBe(id);
    expect(listMonos()).toHaveLength(1);
  });

  it("gets new projects once and keeps one the user took off it", () => {
    const id = ensureStylistMono([APP])!;
    ensureStylistMono([APP, SITE]);
    expect(findMono(id)!.projects).toEqual([APP, SITE]);
    removeMonoProject(id, SITE);
    ensureStylistMono([APP, SITE]);
    expect(findMono(id)!.projects).toEqual([APP]);
  });

  it("stays deleted once the user deletes it", async () => {
    // happy-dom has no Web Locks; the app's WebKit does.
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: (_name: string, work: () => unknown) => Promise.resolve(work()) },
    });
    const id = (await seedStylistMono([APP]))!;
    expect(findMono(id)?.name).toBe(STYLIST_NAME);
    removeMono(id);
    expect(ensureStylistMono([APP, SITE])).toBeUndefined();
    expect(listMonos()).toHaveLength(0);
  });

  it("finds its icons folder and applies an icon it made there", async () => {
    const id = ensureStylistMono([APP, SITE])!;
    const mono = findMono(id)!;
    const session = newSession("claude", "/Users/sam");
    const dir = "/data/monos/stylist";
    const host = {
      isMono: () => true,
      monoOf: () => ({ id, projects: mono.projects }),
      agentFiles: async () => ({ dir }),
    } as unknown as AgentAppHost;

    const result = await handleAgentApp(session, "look", "projects.look", { project: "site" }, host) as ProjectLook;
    expect(result.project).toBe(SITE);
    expect(result.iconsDir).toBe(`${dir}/icons`);

    mocks.invoke.mockImplementation(async (command: string) =>
      command === "save_project_logo" ? "/data/project-logos/site.svg" : undefined);
    await handleAgentApp(session, "logo", "projects.logo.set", {
      project: "site", path: `${dir}/icons/site-v1.svg`,
    }, host);
    expect(mocks.invoke).toHaveBeenCalledWith("save_project_logo", {
      project: SITE, projectRoot: `${dir}/icons`, sourcePath: `${dir}/icons/site-v1.svg`,
    });

    // A path anywhere else is still checked against the project folder.
    await handleAgentApp(session, "logo2", "projects.logo.set", {
      project: "site", path: "public/logo.svg",
    }, host);
    expect(mocks.invoke).toHaveBeenCalledWith("save_project_logo", {
      project: SITE, projectRoot: SITE, sourcePath: "public/logo.svg",
    });
    saveTabGroupMascot(SITE, null);
  });
});

// Fork: like any Mono, the Stylist can hand code work to project sessions.
describe("the Stylist can start project sessions", () => {
  const files = (id: string) => ({
    id, dir: "/data", soul: "Be brief.", soulHash: "s", memory: "", memoryHash: "m",
    memoryPath: "/data/MEMORY.md", topics: [],
  });
  const look = { name: "Stylist", mascot: "beret", color: "#fff", projects: [{ path: APP, name: "app" }] };

  it("gets the same delegation rules as other Monos", () => {
    const id = ensureStylistMono([APP])!;
    const stylist = monoContext(look, files(id), { soul: true, memory: false });
    expect(stylist).toContain("<session_delegation_rules>");
    expect(stylist).toContain("<habits_rules>");
    expect(stylist).not.toContain("<stylist_rules>");
  });

  it("can start a project session", async () => {
    const id = ensureStylistMono([APP])!;
    const none = { claude: false, codex: false, cursor: false, grok: false, opencode: false, pi: false, omp: false,
      fx: false, hermes: false, deepseek: false, antigravity: false, devin: false, vivobook: false } as HarnessAvailability;
    setHarnessAvailability({ ...none, codex: true });
    setHarnessModels("codex", [{ id: "codex:test", harness: "codex", name: "Test model", settings: [] }]);
    const source = newSession("codex", APP, "codex:test");
    const start = vi.fn(async () => {});
    const host = {
      start,
      isMono: () => true,
      monoOf: () => ({ id, projects: [APP] }),
    } as unknown as AgentAppHost;
    await handleAgentApp(source, "req1", "sessions.start", {
      prompt: "add a mascot", draft: true,
    }, host);
    expect(start).toHaveBeenCalledOnce();
    resetHarnessModelOverlays();
    setHarnessAvailability(none);
  });

  it("upgrades a saved soul once at launch", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: (_name: string, work: () => unknown) => Promise.resolve(work()) },
    });
    const old = "You never write code or change files inside a project; projects are read-only to you.\n- Prefer pink.\n";
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "mono_read" ? { text: old, hash: "h1" } : command === "mono_save" ? "h2" : undefined);
    await seedStylistMono([APP]);
    const saves = mocks.invoke.mock.calls.filter(([command]) => command === "mono_save");
    expect(saves).toHaveLength(1);
    const saved = (saves[0][1] as { text: string }).text;
    expect(saved).toContain("app sessions.start");
    expect(saved).toContain("- Prefer pink.");
    mocks.invoke.mockClear();
    await seedStylistMono([APP]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "mono_read")).toHaveLength(0);
  });

  it("drops the old no-sessions lines from a saved soul and keeps the rest", () => {
    const old = "You are the Stylist. You never write code or change files inside a project; projects are read-only to you.\n\n"
      + "- Your projects are the user's local projects.\n"
      + "- Do all of this yourself. Never start or message project sessions; those are coding agents that can change files.\n"
      + "- Prefer pink.\n";
    const next = withoutOldStylistLines(old);
    expect(next).not.toContain("Never start");
    expect(next).not.toContain("read-only to you");
    expect(next).toContain("app sessions.start");
    expect(next).toContain("- Prefer pink.");
    expect(withoutOldStylistLines(next)).toBe(next);
    expect(withoutOldStylistLines(STYLIST_SOUL)).toBe(STYLIST_SOUL);
  });
});
