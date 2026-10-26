// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, RUNTIME_MODES, type RuntimeMode } from "../../sessions/model/session";
import { createMono, findMono, listMonos, saveMonoSessionId, updateMono } from "../../monos/model/mono";
import { type Habit } from "../../monos/model/monoHabits";
import { MonoFileConflict } from "../../monos/model/monoFiles";
import { handleAgentApp, type AgentAppHost } from "./agentApp";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  // Model the origin-wide Web Lock queue; different host fixtures are windows.
  const pending = new Map<string, Promise<unknown>>();
  vi.stubGlobal("navigator", {
    locks: {
      request: vi.fn(<T,>(name: string, work: () => Promise<T>) => {
        const next = (pending.get(name) ?? Promise.resolve()).catch(() => {}).then(work);
        pending.set(name, next);
        return next;
      }),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const review = {
  name: "Daily review",
  instructions: "Review recent changes; report anything that needs my attention.",
  schedule: { kind: "daily", time: "09:00" },
};

function fixture(runtimeMode: RuntimeMode = "supervised") {
  const source = newSession("codex", "/project", "codex:test", runtimeMode);
  const files = new Map<string, { text: string; hash: string }>();
  const habits = new Map<string, Habit[]>();
  const host = {
    isMono: vi.fn(() => false),
    isHabitRun: vi.fn(() => false),
    monos: {
      enabled: vi.fn(() => true),
      prepare: vi.fn(async (id: string) => {
        if (!findMono(id)?.sessionId) saveMonoSessionId(id, `session-${id}`);
      }),
    },
    readAgentFile: vi.fn(async (id: string) => files.get(id) ?? { text: null, hash: "empty" }),
    writeAgentFile: vi.fn(async (id: string, _path: string, text: string, hash: string) => {
      if (hash !== (files.get(id)?.hash ?? "empty")) throw new Error("conflict");
      const next = { text, hash: `hash-${text}` };
      files.set(id, next);
      return next.hash;
    }),
    habits: {
      load: vi.fn(async (id: string) => habits.get(id) ?? []),
      update: vi.fn(async <T,>(id: string, change: (list: Habit[]) => { habits: Habit[]; result: T }) => {
        const next = change(habits.get(id) ?? []);
        habits.set(id, next.habits);
        return next.result;
      }),
    },
    now: () => new Date(2026, 9, 26, 12),
  };
  const call = (action: string, input: Record<string, unknown> = {}) =>
    handleAgentApp(source, "request", action, input, host as unknown as AgentAppHost);
  return { source, host, files, habits, call };
}

function mono(name: string, projects = ["/project"]) {
  const entry = createMono(projects);
  updateMono(entry.id, current => ({ ...current, name }));
  return entry.id;
}

describe("project Mono configuration", () => {
  it.each(["missing", "denied"])("does not configure without a shared window lock (%s)", async state => {
    const { call, host } = fixture();
    vi.stubGlobal("navigator", state === "missing" ? {} : {
      locks: { request: vi.fn().mockRejectedValue(new Error("Access denied")) },
    });
    await expect(call("monos.configure", { name: "Reviewer" })).rejects.toThrow("coordinate Mono setup");
    expect(listMonos()).toEqual([]);
    expect(host.monos.prepare).not.toHaveBeenCalled();
    expect(await call("monos.list")).toEqual({ enabled: true, monos: [] });
  });

  it.each(["name", "id"])("serializes competing configure calls targeting the same new Mono by %s", async target => {
    const { call, host, source, files } = fixture("full-access");
    let releaseRead!: () => void;
    const reading = new Promise<void>(resolve => { releaseRead = resolve; });
    let readStarted!: () => void;
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    host.readAgentFile.mockImplementationOnce(async () => {
      readStarted();
      await reading;
      return { text: null, hash: "empty" };
    });
    let conversationMode: RuntimeMode | undefined;
    host.monos.prepare.mockImplementation(async id => {
      if (!findMono(id)?.sessionId) {
        conversationMode = source.runtimeMode;
        saveMonoSessionId(id, "resident");
      }
    });
    const otherHost = { ...host, monos: { ...host.monos, prepare: vi.fn(async (id: string) => {
      if (!findMono(id)?.sessionId) {
        conversationMode = "supervised";
        saveMonoSessionId(id, "other-resident");
      }
    }) } };
    const first = call("monos.configure", { name: "Reviewer", instructions: "Be concise." });
    await started;
    const id = listMonos()[0].id;
    const second = handleAgentApp(
      { ...source, id: "other-source", runtimeMode: "supervised" }, "other-request", "monos.configure",
      target === "name" ? { name: "Reviewer" } : { id }, otherHost as unknown as AgentAppHost,
    );
    await Promise.resolve();
    try {
      expect(otherHost.monos.prepare).not.toHaveBeenCalled();
    } finally {
      releaseRead();
    }
    expect(await first).toMatchObject({ created: true });
    expect(await second).toMatchObject({ created: false, mono: { id } });
    expect(listMonos()).toHaveLength(1);
    expect(conversationMode).toBe("full-access");
    expect(files.get(id)?.text).toBe("Be concise.");
  });

  it("lists only Monos dedicated to this project, without reading other files", async () => {
    const { call, host } = fixture();
    const id = mono("Reviewer");
    mono("Other", ["/other"]);
    mono("Shared", ["/project", "/other"]);
    expect(await call("monos.list")).toMatchObject({ enabled: true, monos: [{ id, name: "Reviewer", project: "/project" }] });
    expect(host.readAgentFile).toHaveBeenCalledExactlyOnceWith(id, "SOUL.md");
    expect(host.monos.prepare).not.toHaveBeenCalled();
  });

  it("creates a quiet Mono and paused habit; repeating the request reuses both", async () => {
    const { call, host, habits } = fixture("full-access");
    const input = { name: "Reviewer", instructions: "Be concise.", habit: review };
    const first = await call("monos.configure", input);
    expect(first).toMatchObject({ created: true, mono: { name: "Reviewer", instructions: "Be concise.", habits: [{ enabled: false, runtimeMode: "full-access" }] } });
    expect(await call("monos.configure", input)).toMatchObject({ created: false });
    expect(listMonos()).toHaveLength(1);
    expect(habits.get(listMonos()[0].id)).toHaveLength(1);
    expect(host.monos.prepare).toHaveBeenCalledTimes(2);
    expect(host.writeAgentFile).toHaveBeenCalledOnce();
  });

  it.each(["readAgentFile", "writeAgentFile"] as const)("preserves the quiet Mono after initial %s failure and resumes creation on retry", async operation => {
    const { call, host, habits } = fixture("full-access");
    const input = { name: "Reviewer", instructions: "Be concise.", habit: review };
    host[operation].mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(call("monos.configure", input)).rejects.toThrow("Storage unavailable");
    const original = listMonos()[0];
    expect(original.sessionId).toBeDefined();
    expect(host.monos.prepare).toHaveBeenCalledOnce();
    expect(host.habits.update).not.toHaveBeenCalled();
    expect(await call("monos.configure", input)).toMatchObject({ created: false, mono: { id: original.id } });
    expect(listMonos()).toHaveLength(1);
    expect(listMonos()[0].sessionId).toBe(original.sessionId);
    expect(habits.get(listMonos()[0].id)).toHaveLength(1);
  });

  it("does not read or change SOUL until the quiet conversation is prepared", async () => {
    const { call, host } = fixture("full-access");
    const input = { name: "Reviewer", instructions: "Be concise." };
    host.monos.prepare.mockRejectedValueOnce(new Error("Could not persist"));
    await expect(call("monos.configure", input)).rejects.toThrow("Could not persist");
    const id = listMonos()[0].id;
    expect(host.readAgentFile).not.toHaveBeenCalled();
    expect(host.writeAgentFile).not.toHaveBeenCalled();
    expect(await call("monos.configure", input)).toMatchObject({ created: false, mono: { id } });
  });

  it("requires a hash for an existing empty SOUL, but can initialize an absent file", async () => {
    const { call, files, host } = fixture("full-access");
    const id = mono("Reviewer");
    files.set(id, { text: "", hash: "empty-file" });
    await expect(call("monos.configure", { id, instructions: "Be concise." })).rejects.toThrow("soulHash");
    expect(host.writeAgentFile).not.toHaveBeenCalled();
    files.delete(id);
    await call("monos.configure", { id, instructions: "Be concise." });
    expect(files.get(id)?.text).toBe("Be concise.");
  });

  it.each([
    { name: "Changed elsewhere" },
    { projects: ["/project", "/other"] },
    { sessionId: "opened-elsewhere" },
  ])("keeps a new Mono changed elsewhere during failed SOUL setup: %j", async patch => {
    const { call, host } = fixture("full-access");
    host.readAgentFile.mockImplementationOnce(async id => {
      updateMono(id, current => ({ ...current, ...patch }));
      throw new Error("Storage unavailable");
    });
    await expect(call("monos.configure", { name: "Reviewer", instructions: "Be concise." })).rejects.toThrow("Storage unavailable");
    expect(listMonos()).toHaveLength(1);
    expect(listMonos()[0]).toMatchObject(patch);
  });

  it("preserves a new Mono if another writer changed its SOUL", async () => {
    const { call, host, files } = fixture("full-access");
    host.writeAgentFile.mockImplementationOnce(async id => {
      files.set(id, { text: "Another writer's instructions.", hash: "other" });
      throw new MonoFileConflict();
    });
    await expect(call("monos.configure", { name: "Reviewer", instructions: "Be concise." })).rejects.toThrow("changed");
    expect(listMonos()).toHaveLength(1);
    expect(files.get(listMonos()[0].id)?.text).toBe("Another writer's instructions.");
  });

  it("never rolls back an existing Mono after a SOUL storage failure", async () => {
    const { call, host } = fixture("full-access");
    const id = mono("Reviewer");
    host.readAgentFile.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(call("monos.configure", { id, instructions: "Be concise." })).rejects.toThrow("Storage unavailable");
    expect(listMonos().map(entry => entry.id)).toEqual([id]);
  });

  it("keeps an initialized Mono and session after a habit save failure, then resumes the same-name request", async () => {
    const { call, host, habits } = fixture("full-access");
    const input = { name: "Reviewer", instructions: "Be concise.", habit: review };
    host.habits.update.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(call("monos.configure", input)).rejects.toThrow("Storage unavailable");
    const created = listMonos()[0];
    expect(created.sessionId).toBeDefined();
    expect(await call("monos.configure", input)).toMatchObject({ created: false, mono: { id: created.id } });
    expect(listMonos()).toHaveLength(1);
    expect(host.monos.prepare).toHaveBeenCalledTimes(2);
    expect(habits.get(created.id)).toHaveLength(1);
  });

  it("enables requested recurring work and updates or pauses it by id", async () => {
    const { call, habits, source } = fixture();
    await call("monos.configure", { name: "Reviewer", habit: { ...review, enabled: true } });
    const id = listMonos()[0].id;
    const habit = habits.get(id)![0];
    expect(habit).toMatchObject({ enabled: true, runtimeMode: "supervised" });
    expect(habit.nextRunAt).toBeGreaterThan(new Date(2026, 9, 26, 12).getTime());
    source.runtimeMode = "full-access";
    await call("monos.configure", { id, habit: { id: habit.id, enabled: false } });
    expect(habits.get(id)).toEqual([{ ...habit, enabled: false }]);
  });

  it("requires the current soul hash before replacing existing instructions", async () => {
    const { call, files, host } = fixture("full-access");
    const id = mono("Reviewer");
    files.set(id, { text: "Original.", hash: "v1" });
    await expect(call("monos.configure", { id, instructions: "New.", habit: review })).rejects.toThrow("soulHash");
    expect(host.habits.update).not.toHaveBeenCalled();
    expect(host.writeAgentFile).not.toHaveBeenCalled();
    await expect(call("monos.configure", { id, instructions: "New.", expectedSoulHash: "stale" })).rejects.toThrow("soulHash");
    await call("monos.configure", { id, instructions: "New.", expectedSoulHash: "v1" });
    expect(files.get(id)?.text).toBe("New.");
  });

  it.each(RUNTIME_MODES.filter(mode => mode !== "full-access").flatMap(mode => [false, true].map(existing => [mode, existing] as const)))(
    "%s cannot set standing instructions (existing=%s) before any mutation",
    async (mode, existing) => {
      const { call, host, files } = fixture(mode);
      const id = existing ? mono("Reviewer") : undefined;
      if (id) files.set(id, { text: "Original.", hash: "v1" });
      const before = listMonos();
      await expect(call("monos.configure", {
        ...(id ? { id } : {}), name: "Changed", instructions: "New.", expectedSoulHash: "v1", habit: review,
      })).rejects.toThrow("Full access");
      expect(listMonos()).toEqual(before);
      expect(host.monos.prepare).not.toHaveBeenCalled();
      expect(host.readAgentFile).not.toHaveBeenCalled();
      expect(host.writeAgentFile).not.toHaveBeenCalled();
      expect(host.habits.load).not.toHaveBeenCalled();
      expect(host.habits.update).not.toHaveBeenCalled();
    },
  );

  it.each(RUNTIME_MODES.filter(mode => mode !== "full-access"))(
    "%s cannot submit the standing-instructions field even if its contents are unchanged",
    async mode => {
      const { call, host, files } = fixture(mode);
      const id = mono("Reviewer");
      files.set(id, { text: "Original.", hash: "v1" });
      await expect(call("monos.configure", { id, instructions: "Original.", expectedSoulHash: "v1" })).rejects.toThrow("Full access");
      expect(host.monos.prepare).not.toHaveBeenCalled();
      expect(host.readAgentFile).not.toHaveBeenCalled();
      expect(host.writeAgentFile).not.toHaveBeenCalled();
    },
  );

  it.each(RUNTIME_MODES)("allows %s sessions to configure daily-review habit instructions", async mode => {
    const { call, host, habits } = fixture(mode);
    await call("monos.configure", { name: "Reviewer", habit: { ...review, enabled: true } });
    const id = listMonos()[0].id;
    expect(habits.get(id)).toEqual([expect.objectContaining({
      name: review.name, instructions: review.instructions, enabled: true, runtimeMode: mode,
    })]);
    expect(host.writeAgentFile).not.toHaveBeenCalled();
  });

  it.each(RUNTIME_MODES.flatMap(saved => RUNTIME_MODES.map(source => [saved, source] as const)))(
    "never loosens saved %s permissions from a %s source",
    async (savedMode, sourceMode) => {
      const { call, source, habits } = fixture();
      source.runtimeMode = savedMode;
      await call("monos.configure", { name: "Reviewer", habit: review });
      const id = listMonos()[0].id;
      source.runtimeMode = sourceMode;
      await call("monos.configure", { id, habit: { name: review.name, enabled: true } });
      expect(habits.get(id)![0].runtimeMode).toBe(
        RUNTIME_MODES[Math.min(RUNTIME_MODES.indexOf(savedMode), RUNTIME_MODES.indexOf(sourceMode))],
      );
    },
  );

  it.each([["/other"], ["/project", "/other"]])("rejects configuring a Mono assigned to %j", async (...projects) => {
    const { call, host } = fixture();
    const id = mono("Other", projects);
    await expect(call("monos.configure", { id, name: "Renamed", habit: review })).rejects.toThrow("exclusive");
    expect(host.habits.load).not.toHaveBeenCalled();
    expect(host.writeAgentFile).not.toHaveBeenCalled();
  });

  it.each([
    { name: "Reviewer", project: "/other" },
    { name: "Reviewer", habit: { ...review, runtimeMode: "full-access" } },
    { name: "Reviewer", habit: { ...review, schedule: { kind: "daily", time: "25:00" } } },
    { name: "Reviewer", habit: { name: "Incomplete" } },
    { name: "Reviewer", habit: { ...review, enabled: "yes" } },
  ])("validates input before creating anything: %j", async input => {
    const { call, host } = fixture();
    await expect(call("monos.configure", input)).rejects.toThrow();
    expect(listMonos()).toEqual([]);
    expect(host.writeAgentFile).not.toHaveBeenCalled();
    expect(host.monos.prepare).not.toHaveBeenCalled();
  });

  it("rejects a Mono whose scope changes while habits load", async () => {
    const { call, host } = fixture();
    const id = mono("Reviewer");
    host.habits.load.mockImplementationOnce(async () => {
      updateMono(id, current => ({ ...current, projects: ["/project", "/other"] }));
      return [];
    });
    await expect(call("monos.configure", { id, name: "Changed", habit: review })).rejects.toThrow("exclusive");
    expect(host.habits.update).not.toHaveBeenCalled();
    expect(host.monos.prepare).not.toHaveBeenCalled();
    expect(listMonos()[0].name).toBe("Reviewer");
  });

  it("rechecks scope after preparing the Mono session", async () => {
    const { call, host } = fixture();
    const id = mono("Reviewer");
    host.monos.prepare.mockImplementationOnce(async () => {
      updateMono(id, current => ({ ...current, projects: ["/other"] }));
    });
    await expect(call("monos.configure", { id, habit: review })).rejects.toThrow("exclusive");
    expect(host.habits.update).not.toHaveBeenCalled();
  });

  it("rechecks scope inside the atomic habits update", async () => {
    const { call, host, habits } = fixture();
    const id = mono("Reviewer");
    host.habits.update.mockImplementationOnce(async (monoId, change) => {
      updateMono(monoId, current => ({ ...current, projects: ["/project", "/other"] }));
      return change([]).result;
    });
    await expect(call("monos.configure", { id, habit: review })).rejects.toThrow("exclusive");
    expect(habits.has(id)).toBe(false);
  });

  it("keeps the user's disabled Monos setting off", async () => {
    const { call, host } = fixture();
    host.monos.enabled.mockReturnValue(false);
    expect(await call("monos.list")).toEqual({ enabled: false, monos: [] });
    await expect(call("monos.configure", { name: "Reviewer" })).rejects.toThrow("Settings");
    expect(listMonos()).toEqual([]);
  });

  it.each(["/", "~", "remote://server/project"])("rejects non-local project %s", async cwd => {
    const { source, call } = fixture();
    source.cwd = cwd;
    await expect(call("monos.configure", { name: "Reviewer" })).rejects.toThrow("local project");
    expect(listMonos()).toEqual([]);
  });

  it.each(["isMono", "isHabitRun"] as const)("does not let %s sessions create more Monos", async kind => {
    const { host, call } = fixture();
    host[kind].mockReturnValue(true);
    await expect(call("monos.configure", { name: "Reviewer" })).rejects.toThrow("ordinary");
    expect(listMonos()).toEqual([]);
  });
});
